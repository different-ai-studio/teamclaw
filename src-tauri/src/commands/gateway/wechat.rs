use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::{oneshot, RwLock};
use serde::Deserialize;
use super::session::SessionMapping;
use super::wechat_config::{
    WeChatConfig, WeChatGatewayStatus, WeChatGatewayStatusResponse,
    WeChatQrLoginResponse, WeChatQrStatusResponse,
};
use super::{ProcessedMessageTracker, MAX_PROCESSED_MESSAGES};
use super::session_queue::{SessionQueue, QueuedMessage, EnqueueResult, RejectReason};

const ILINK_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const LONG_POLL_TIMEOUT_MS: u64 = 35_000;
const MAX_CONSECUTIVE_FAILURES: u32 = 3;
const BACKOFF_DELAY_MS: u64 = 30_000;
const RETRY_DELAY_MS: u64 = 2_000;
const CHANNEL_VERSION: &str = "0.1.0";

const MSG_TYPE_USER: u64 = 1;
const MSG_ITEM_TEXT: u64 = 1;
const MSG_ITEM_VOICE: u64 = 3;
const MSG_TYPE_BOT: u64 = 2;
const MSG_STATE_FINISH: u64 = 2;

// ---------------------------------------------------------------------------
// ilink message types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct ILinkTextItem {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ILinkVoiceItem {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ILinkRefMsg {
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ILinkMessageItem {
    #[serde(default, rename = "type")]
    item_type: Option<u64>,
    #[serde(default)]
    text_item: Option<ILinkTextItem>,
    #[serde(default)]
    voice_item: Option<ILinkVoiceItem>,
    #[serde(default)]
    ref_msg: Option<ILinkRefMsg>,
}

#[derive(Debug, Clone, Deserialize)]
struct ILinkMessage {
    #[serde(default)]
    from_user_id: Option<String>,
    #[serde(default)]
    to_user_id: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    message_type: Option<u64>,
    #[serde(default)]
    item_list: Option<Vec<ILinkMessageItem>>,
    #[serde(default)]
    context_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GetUpdatesResponse {
    #[serde(default)]
    ret: Option<i32>,
    #[serde(default)]
    errcode: Option<i32>,
    #[serde(default)]
    errmsg: Option<String>,
    #[serde(default)]
    msgs: Option<Vec<ILinkMessage>>,
    #[serde(default)]
    get_updates_buf: Option<String>,
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

fn random_wechat_uin() -> String {
    use base64::Engine;
    let uint32: u32 = getrandom_u32();
    base64::engine::general_purpose::STANDARD.encode(uint32.to_string().as_bytes())
}

/// Generate a random u32 using getrandom (no `rand` crate needed)
fn getrandom_u32() -> u32 {
    let mut buf = [0u8; 4];
    getrandom::getrandom(&mut buf).unwrap_or_default();
    u32::from_le_bytes(buf)
}

fn build_ilink_headers(token: Option<&str>) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Content-Type", "application/json".parse().unwrap());
    headers.insert("AuthorizationType", "ilink_bot_token".parse().unwrap());
    headers.insert("X-WECHAT-UIN", random_wechat_uin().parse().unwrap());
    if let Some(t) = token {
        if !t.is_empty() {
            headers.insert(
                "Authorization",
                format!("Bearer {}", t.trim()).parse().unwrap(),
            );
        }
    }
    headers
}

// ---------------------------------------------------------------------------
// QR login functions (pub — used by Tauri commands)
// ---------------------------------------------------------------------------

/// Fetch QR code for WeChat login
pub async fn fetch_qr_code(base_url: &str) -> Result<WeChatQrLoginResponse, String> {
    let url = format!(
        "{}/ilink/bot/get_bot_qrcode?bot_type=3",
        base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("QR fetch failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("QR fetch failed: HTTP {}", resp.status()));
    }
    resp.json::<WeChatQrLoginResponse>()
        .await
        .map_err(|e| format!("QR parse failed: {}", e))
}

/// Poll QR code scan status
pub async fn poll_qr_status(base_url: &str, qrcode: &str) -> Result<WeChatQrStatusResponse, String> {
    let url = format!(
        "{}/ilink/bot/get_qrcode_status?qrcode={}",
        base_url.trim_end_matches('/'),
        urlencoding::encode(qrcode)
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(35))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("iLink-App-ClientVersion", "1")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                return "timeout".to_string();
            }
            format!("QR status failed: {}", e)
        })?;
    if !resp.status().is_success() {
        return Err(format!("QR status failed: HTTP {}", resp.status()));
    }
    resp.json::<WeChatQrStatusResponse>()
        .await
        .map_err(|e| format!("QR status parse failed: {}", e))
}

// ---------------------------------------------------------------------------
// getupdates / sendmessage (pub — used by Tauri commands and cron delivery)
// ---------------------------------------------------------------------------

/// Long-poll for new messages
pub async fn get_updates(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    get_updates_buf: &str,
) -> Result<GetUpdatesResponse, String> {
    let url = format!(
        "{}/ilink/bot/getupdates",
        base_url.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "get_updates_buf": get_updates_buf,
        "base_info": { "channel_version": CHANNEL_VERSION },
    });
    let headers = build_ilink_headers(Some(token));
    let resp = client
        .post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                return "timeout".to_string();
            }
            format!("getupdates failed: {}", e)
        })?;
    if !resp.status().is_success() {
        return Err(format!("getupdates HTTP {}", resp.status()));
    }
    resp.json::<GetUpdatesResponse>()
        .await
        .map_err(|e| format!("getupdates parse failed: {}", e))
}

/// Send a text message back to WeChat
pub async fn send_text_message(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    to_user_id: &str,
    text: &str,
    context_token: &str,
) -> Result<(), String> {
    let url = format!(
        "{}/ilink/bot/sendmessage",
        base_url.trim_end_matches('/')
    );
    let client_id = format!(
        "teamclaw:{}-{:08x}",
        chrono::Utc::now().timestamp_millis(),
        getrandom_u32()
    );
    let body = serde_json::json!({
        "msg": {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": client_id,
            "message_type": MSG_TYPE_BOT,
            "message_state": MSG_STATE_FINISH,
            "item_list": [{ "type": MSG_ITEM_TEXT, "text_item": { "text": text } }],
            "context_token": context_token,
        },
        "base_info": { "channel_version": CHANNEL_VERSION },
    });
    let headers = build_ilink_headers(Some(token));
    let resp = client
        .post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sendmessage failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("sendmessage HTTP {}: {}", status, body));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Text extraction helper
// ---------------------------------------------------------------------------

fn extract_text_from_message(msg: &ILinkMessage) -> String {
    let items = match &msg.item_list {
        Some(items) if !items.is_empty() => items,
        _ => return String::new(),
    };
    for item in items {
        match item.item_type {
            Some(t) if t == MSG_ITEM_TEXT => {
                if let Some(text) = item.text_item.as_ref().and_then(|ti| ti.text.as_ref()) {
                    if let Some(ref_msg) = &item.ref_msg {
                        if let Some(title) = &ref_msg.title {
                            return format!("[引用: {}]\n{}", title, text);
                        }
                    }
                    return text.clone();
                }
            }
            Some(t) if t == MSG_ITEM_VOICE => {
                if let Some(text) = item.voice_item.as_ref().and_then(|vi| vi.text.as_ref()) {
                    return text.clone();
                }
            }
            other => {
                eprintln!("[WeChat] Unknown message item type: {:?}", other);
            }
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// WeChatGateway struct
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct WeChatGateway {
    config: Arc<RwLock<WeChatConfig>>,
    session_mapping: SessionMapping,
    opencode_port: u16,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<WeChatGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    processed_messages: Arc<RwLock<ProcessedMessageTracker>>,
    #[allow(dead_code)]
    permission_approver: super::PermissionAutoApprover,
    session_queue: Arc<SessionQueue>,
    #[allow(dead_code)]
    pending_questions: Arc<super::PendingQuestionStore>,
    /// Cache of from_user_id -> context_token for replies
    context_tokens: Arc<RwLock<HashMap<String, String>>>,
}

impl WeChatGateway {
    pub fn new(opencode_port: u16, session_mapping: SessionMapping) -> Self {
        Self {
            config: Arc::new(RwLock::new(WeChatConfig::default())),
            session_mapping,
            opencode_port,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(WeChatGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            processed_messages: Arc::new(RwLock::new(ProcessedMessageTracker::new(MAX_PROCESSED_MESSAGES))),
            permission_approver: super::PermissionAutoApprover::new(opencode_port),
            session_queue: Arc::new(SessionQueue::new()),
            pending_questions: Arc::new(super::PendingQuestionStore::new()),
            context_tokens: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn set_config(&self, config: WeChatConfig) {
        *self.config.write().await = config;
    }

    pub async fn get_status(&self) -> WeChatGatewayStatusResponse {
        self.status.read().await.clone()
    }

    async fn set_status(&self, status: WeChatGatewayStatus, error: Option<String>) {
        let mut s = self.status.write().await;
        s.status = status;
        s.error_message = error;
    }

    /// Get cached context_token for a user (used by cron delivery)
    pub async fn get_context_token(&self, user_id: &str) -> Option<String> {
        self.context_tokens.read().await.get(user_id).cloned()
    }

    /// Send a message to a WeChat user (used by cron delivery and reply)
    pub async fn send_to_user(&self, to_user_id: &str, text: &str) -> Result<(), String> {
        let config = self.config.read().await;
        let context_token = self.context_tokens.read().await
            .get(to_user_id)
            .cloned()
            .ok_or_else(|| format!("No context_token for user {}. User must send a message first.", to_user_id))?;
        let client = reqwest::Client::new();
        send_text_message(&client, &config.base_url, &config.bot_token, to_user_id, text, &context_token).await
    }

    pub async fn start(&self) -> Result<(), String> {
        let is_running = *self.is_running.read().await;
        if is_running {
            return Err("WeChat gateway is already running".to_string());
        }

        let config = self.config.read().await.clone();
        if config.bot_token.is_empty() {
            return Err("WeChat bot_token is empty. Please complete QR login first.".to_string());
        }

        *self.is_running.write().await = true;
        self.set_status(WeChatGatewayStatus::Connecting, None).await;

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        let gateway = self.clone();
        tokio::spawn(async move {
            gateway.run_poll_loop(shutdown_rx).await;
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let tx = self.shutdown_tx.write().await.take();
        if let Some(tx) = tx {
            let _ = tx.send(());
        }
        *self.is_running.write().await = false;
        self.set_status(WeChatGatewayStatus::Disconnected, None).await;
        self.session_queue.shutdown().await;
        Ok(())
    }

    async fn run_poll_loop(&self, mut shutdown_rx: oneshot::Receiver<()>) {
        let config = self.config.read().await.clone();
        let mut get_updates_buf = config.sync_buf.unwrap_or_default();
        let mut consecutive_failures: u32 = 0;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(LONG_POLL_TIMEOUT_MS + 5000))
            .build()
            .unwrap_or_default();

        self.set_status(WeChatGatewayStatus::Connected, None).await;
        {
            let mut s = self.status.write().await;
            s.account_id = Some(config.account_id.clone());
        }
        println!("[WeChat] Gateway connected, starting long-poll loop");

        loop {
            // Check for shutdown
            match shutdown_rx.try_recv() {
                Ok(_) | Err(oneshot::error::TryRecvError::Closed) => {
                    println!("[WeChat] Shutdown signal received");
                    break;
                }
                Err(oneshot::error::TryRecvError::Empty) => {}
            }

            match get_updates(&client, &config.base_url, &config.bot_token, &get_updates_buf).await {
                Ok(resp) => {
                    // Check for API errors
                    let is_error = resp.ret.unwrap_or(0) != 0 || resp.errcode.unwrap_or(0) != 0;
                    if is_error {
                        consecutive_failures += 1;
                        let err_msg = format!(
                            "getupdates error: ret={:?} errcode={:?} errmsg={:?}",
                            resp.ret, resp.errcode, resp.errmsg
                        );
                        eprintln!("[WeChat] {}", err_msg);

                        // Check for auth errors (don't retry these)
                        if resp.errcode == Some(401) || resp.errcode == Some(403) {
                            self.set_status(
                                WeChatGatewayStatus::Error,
                                Some("Token expired or invalid. Please re-authenticate.".to_string()),
                            ).await;
                            break;
                        }

                        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                            self.set_status(WeChatGatewayStatus::Error, Some(err_msg)).await;
                            consecutive_failures = 0;
                            tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_DELAY_MS)).await;
                        } else {
                            tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                        }
                        continue;
                    }

                    consecutive_failures = 0;

                    // Save sync buf
                    if let Some(buf) = &resp.get_updates_buf {
                        get_updates_buf = buf.clone();
                        // Persist sync_buf to config
                        let mut cfg = self.config.write().await;
                        cfg.sync_buf = Some(buf.clone());
                    }

                    // Process messages
                    if let Some(msgs) = &resp.msgs {
                        for msg in msgs {
                            if msg.message_type != Some(MSG_TYPE_USER) {
                                continue;
                            }
                            let text = extract_text_from_message(msg);
                            if text.is_empty() {
                                continue;
                            }
                            let sender_id = msg.from_user_id.clone().unwrap_or_else(|| "unknown".to_string());

                            // Cache context token
                            if let Some(ct) = &msg.context_token {
                                self.context_tokens.write().await.insert(sender_id.clone(), ct.clone());
                            }

                            println!("[WeChat] Message from {}: {}...", sender_id, &text[..text.len().min(50)]);

                            // Forward to OpenCode session
                            let gateway = self.clone();
                            let text_clone = text.clone();
                            let sender_clone = sender_id.clone();
                            tokio::spawn(async move {
                                if let Err(e) = gateway.handle_incoming_message(&sender_clone, &text_clone).await {
                                    eprintln!("[WeChat] Failed to handle message: {}", e);
                                }
                            });
                        }
                    }
                }
                Err(e) => {
                    if e == "timeout" {
                        // Normal long-poll timeout, just retry
                        continue;
                    }
                    consecutive_failures += 1;
                    eprintln!("[WeChat] Poll error: {}", e);
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                        self.set_status(WeChatGatewayStatus::Error, Some(e)).await;
                        consecutive_failures = 0;
                        tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_DELAY_MS)).await;
                    } else {
                        tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                    }
                }
            }
        }

        *self.is_running.write().await = false;
        println!("[WeChat] Poll loop ended");
    }

    async fn handle_incoming_message(&self, sender_id: &str, text: &str) -> Result<(), String> {
        let session_key = format!("wechat:dm:{}", sender_id);

        // Build message for the session queue
        let gateway = self.clone();
        let text = text.to_string();
        let sender_id = sender_id.to_string();

        let process_fn = {
            let gateway = gateway.clone();
            let text = text.clone();
            let sender_id = sender_id.clone();
            Box::new(move || {
                let gateway = gateway.clone();
                let text = text.clone();
                let sender_id = sender_id.clone();
                Box::pin(async move {
                    gateway.process_and_reply(&sender_id, &text).await
                }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
            }) as Box<dyn FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send>
        };

        let notify_fn = {
            let gateway = gateway.clone();
            let sender_id = sender_id.clone();
            Some(Box::new(move |reason: RejectReason| {
                let gateway = gateway.clone();
                let sender_id = sender_id.clone();
                Box::pin(async move {
                    let msg = match reason {
                        RejectReason::Timeout => "Message queue timeout, please try again.",
                        RejectReason::QueueFull => "Too many messages, please wait.",
                        RejectReason::SessionClosed => "Gateway is shutting down.",
                    };
                    let _ = gateway.send_to_user(&sender_id, msg).await;
                }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
            }) as Box<dyn FnOnce(RejectReason) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send>)
        };

        let queued = QueuedMessage {
            enqueued_at: std::time::Instant::now(),
            process_fn,
            notify_fn,
        };

        match self.session_queue.enqueue(&session_key, queued).await {
            EnqueueResult::Processing => {}
            EnqueueResult::Queued { position } => {
                println!("[WeChat] Message queued at position {} for {}", position, session_key);
            }
            EnqueueResult::Full => {
                eprintln!("[WeChat] Message queue full for {}", session_key);
            }
        }

        Ok(())
    }

    async fn process_and_reply(&self, sender_id: &str, text: &str) {
        // Get or create session
        let session_key = format!("wechat:dm:{}", sender_id);
        let session_id = match self.session_mapping.get_session(&session_key).await {
            Some(id) => id,
            None => {
                match super::create_opencode_session(self.opencode_port).await {
                    Ok(id) => {
                        self.session_mapping
                            .set_session(session_key.clone(), id.clone())
                            .await;
                        id
                    }
                    Err(e) => {
                        eprintln!("[WeChat] Failed to create session: {}", e);
                        let _ = self.send_to_user(sender_id, &format!("Error: {}", e)).await;
                        return;
                    }
                }
            }
        };

        // IMPORTANT: Connect to SSE FIRST (before sending message) to avoid missing delta events.
        let port = self.opencode_port;
        let sse_url = format!("http://127.0.0.1:{}/event", port);
        let sse_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(900))
            .build()
            .unwrap_or_default();
        let sse_resp = match sse_client
            .get(&sse_url)
            .header("Accept", "text/event-stream")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[WeChat] SSE connect failed: {}", e);
                let _ = self.send_to_user(sender_id, "Failed to connect to session.").await;
                return;
            }
        };

        // THEN send the prompt
        let prompt_url = format!("http://127.0.0.1:{}/session/{}/prompt_async", port, session_id);
        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "parts": [{ "type": "text", "text": text }],
        });

        match client.post(&prompt_url).json(&body).send().await {
            Ok(resp) if resp.status().is_success() => {
                println!("[WeChat] Message forwarded to session {}", session_id);
            }
            Ok(resp) => {
                let status = resp.status();
                eprintln!("[WeChat] prompt_async failed: HTTP {}", status);
                let _ = self.send_to_user(sender_id, "Failed to process message.").await;
                return;
            }
            Err(e) => {
                eprintln!("[WeChat] prompt_async error: {}", e);
                let _ = self.send_to_user(sender_id, &format!("Error: {}", e)).await;
                return;
            }
        }

        // Stream response back to WeChat using the already-connected SSE
        self.stream_sse_to_wechat(sender_id, sse_resp).await;
    }

    async fn stream_sse_to_wechat(&self, sender_id: &str, resp: reqwest::Response) {
        // Accumulate text and send periodically
        let mut accumulated_text = String::new();
        let mut last_send = std::time::Instant::now();
        let mut bytes_stream = resp.bytes_stream();
        let mut buffer = String::new();

        use futures_util::StreamExt;
        while let Some(chunk) = bytes_stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(_) => break,
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // Parse SSE events from buffer
            while let Some(pos) = buffer.find("\n\n") {
                let event_str = buffer[..pos].to_string();
                buffer = buffer[pos + 2..].to_string();

                // Parse event type and data
                let mut event_type = String::new();
                let mut event_data = String::new();
                for line in event_str.lines() {
                    if let Some(t) = line.strip_prefix("event: ") {
                        event_type = t.to_string();
                    } else if let Some(d) = line.strip_prefix("data: ") {
                        event_data = d.to_string();
                    }
                }

                match event_type.as_str() {
                    "message.part.delta" => {
                        if let Ok(data) = serde_json::from_str::<serde_json::Value>(&event_data) {
                            if let Some(text) = data["delta"]["text"].as_str() {
                                accumulated_text.push_str(text);
                            }
                        }
                        // Send periodically (every 2s or 500+ chars)
                        if (last_send.elapsed().as_secs() >= 2 || accumulated_text.len() >= 500)
                            && !accumulated_text.is_empty()
                        {
                            let _ = self.send_to_user(sender_id, &accumulated_text).await;
                            accumulated_text.clear();
                            last_send = std::time::Instant::now();
                        }
                    }
                    "message.updated" => {
                        if let Ok(data) = serde_json::from_str::<serde_json::Value>(&event_data) {
                            if data["role"].as_str() == Some("assistant")
                                && data["completedTime"].is_string()
                            {
                                // Send final accumulated text
                                if !accumulated_text.is_empty() {
                                    let _ = self.send_to_user(sender_id, &accumulated_text).await;
                                }
                                return;
                            }
                        }
                    }
                    "session.idle" => {
                        // Session done
                        if !accumulated_text.is_empty() {
                            let _ = self.send_to_user(sender_id, &accumulated_text).await;
                        }
                        return;
                    }
                    _ => {}
                }
            }
        }

        // Send any remaining text
        if !accumulated_text.is_empty() {
            let _ = self.send_to_user(sender_id, &accumulated_text).await;
        }
    }
}
