use super::session::SessionMapping;
use super::session_queue::{EnqueueResult, QueuedMessage, RejectReason, SessionQueue};
use super::wechat_config::{
    WeChatConfig, WeChatGatewayStatus, WeChatGatewayStatusResponse, WeChatQrLoginResponse,
    WeChatQrStatusResponse,
};
use super::{ProcessedMessageTracker, MAX_PROCESSED_MESSAGES};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, RwLock};

#[allow(dead_code)]
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
#[allow(dead_code)]
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
pub(crate) struct GetUpdatesResponse {
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
pub async fn poll_qr_status(
    base_url: &str,
    qrcode: &str,
) -> Result<WeChatQrStatusResponse, String> {
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
    let url = format!("{}/ilink/bot/getupdates", base_url.trim_end_matches('/'));
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

/// Quick connection test using a short-timeout getupdates call.
pub async fn test_connection(bot_token: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let base_url = super::wechat_config::default_ilink_base_url();
    match get_updates(&client, &base_url, bot_token, "").await {
        Ok(_) => Ok("Connection successful".to_string()),
        Err(e) if e == "timeout" => Ok("Connection successful".to_string()),
        Err(e) => Err(e),
    }
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
    let url = format!("{}/ilink/bot/sendmessage", base_url.trim_end_matches('/'));
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

fn text_from_text_item(item: &ILinkMessageItem) -> Option<String> {
    item.text_item
        .as_ref()
        .and_then(|ti| ti.text.as_ref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            if let Some(ref_msg) = &item.ref_msg {
                if let Some(title) = &ref_msg.title {
                    return format!("[引用: {}]\n{}", title, s);
                }
            }
            s.to_string()
        })
}

fn text_from_voice_item(item: &ILinkMessageItem) -> Option<String> {
    item.voice_item
        .as_ref()
        .and_then(|vi| vi.text.as_ref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Parse user-visible text from ilink `item_list`.
/// iLink occasionally omits `type` or uses values we have not mapped; still try text/voice payloads.
fn extract_text_from_message(msg: &ILinkMessage) -> String {
    let items = match &msg.item_list {
        Some(items) if !items.is_empty() => items,
        _ => return String::new(),
    };
    let mut fallback: Option<String> = None;

    for item in items {
        match item.item_type {
            Some(t) if t == MSG_ITEM_TEXT => {
                if let Some(s) = text_from_text_item(item) {
                    return s;
                }
            }
            Some(t) if t == MSG_ITEM_VOICE => {
                if let Some(s) = text_from_voice_item(item) {
                    return s;
                }
            }
            _ => {
                if let Some(s) = text_from_text_item(item) {
                    if fallback.is_none() {
                        fallback = Some(s);
                    }
                    continue;
                }
                if let Some(s) = text_from_voice_item(item) {
                    if fallback.is_none() {
                        fallback = Some(s);
                    }
                    continue;
                }
                eprintln!("[WeChat] Unknown message item type: {:?}", item.item_type);
            }
        }
    }

    fallback.unwrap_or_default()
}

// ---------------------------------------------------------------------------
// WeChatGateway struct
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct WeChatGateway {
    config: Arc<RwLock<WeChatConfig>>,
    session_mapping: SessionMapping,
    opencode_port: u16,
    #[allow(dead_code)]
    workspace_path: String,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<WeChatGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    #[allow(dead_code)]
    processed_messages: Arc<RwLock<ProcessedMessageTracker>>,
    #[allow(dead_code)]
    permission_approver: super::PermissionAutoApprover,
    session_queue: Arc<SessionQueue>,
    pending_questions: Arc<super::PendingQuestionStore>,
    /// Cache of from_user_id -> context_token for replies
    context_tokens: Arc<RwLock<HashMap<String, String>>>,
}

impl WeChatGateway {
    pub fn new(opencode_port: u16, session_mapping: SessionMapping, workspace_path: String) -> Self {
        Self {
            config: Arc::new(RwLock::new(WeChatConfig::default())),
            session_mapping,
            opencode_port,
            workspace_path,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(WeChatGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            processed_messages: Arc::new(RwLock::new(ProcessedMessageTracker::new(
                MAX_PROCESSED_MESSAGES,
            ))),
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
    #[allow(dead_code)]
    pub async fn get_context_token(&self, user_id: &str) -> Option<String> {
        self.context_tokens.read().await.get(user_id).cloned()
    }

    /// Send a message to a WeChat user (used by cron delivery and reply)
    pub async fn send_to_user(&self, to_user_id: &str, text: &str) -> Result<(), String> {
        let config = self.config.read().await;
        let context_token = self
            .context_tokens
            .read()
            .await
            .get(to_user_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "No context_token for user {}. User must send a message first.",
                    to_user_id
                )
            })?;
        let client = reqwest::Client::new();
        send_text_message(
            &client,
            &config.base_url,
            &config.bot_token,
            to_user_id,
            text,
            &context_token,
        )
        .await
    }

    /// Persist context_tokens from in-memory config to teamclaw.json on disk
    async fn persist_context_tokens(&self) {
        let config = self.config.read().await.clone();
        let path = format!(
            "{}/{}/{}",
            self.workspace_path,
            crate::commands::TEAMCLAW_DIR,
            crate::commands::CONFIG_FILE_NAME
        );
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut json: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return,
        };
        // Update only the contextTokens field under channels.wechat
        if let Some(wechat) = json.get_mut("channels").and_then(|c| c.get_mut("wechat")) {
            if let Ok(tokens_val) = serde_json::to_value(&config.context_tokens) {
                wechat["contextTokens"] = tokens_val;
            }
        }
        let _ = std::fs::write(
            &path,
            serde_json::to_string_pretty(&json).unwrap_or_default(),
        );
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
        self.set_status(WeChatGatewayStatus::Disconnected, None)
            .await;
        self.session_queue.shutdown().await;
        Ok(())
    }

    async fn run_poll_loop(&self, mut shutdown_rx: oneshot::Receiver<()>) {
        let config = self.config.read().await.clone();
        let mut get_updates_buf = config.sync_buf.unwrap_or_default();
        let mut consecutive_failures: u32 = 0;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(
                LONG_POLL_TIMEOUT_MS + 5000,
            ))
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

            match get_updates(
                &client,
                &config.base_url,
                &config.bot_token,
                &get_updates_buf,
            )
            .await
            {
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
                                Some(
                                    "Token expired or invalid. Please re-authenticate.".to_string(),
                                ),
                            )
                            .await;
                            break;
                        }

                        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                            self.set_status(WeChatGatewayStatus::Error, Some(err_msg))
                                .await;
                            consecutive_failures = 0;
                            tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_DELAY_MS))
                                .await;
                        } else {
                            tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS))
                                .await;
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
                                eprintln!(
                                    "[WeChat] User message dropped: empty text after parse. from={:?}, items={:?}",
                                    msg.from_user_id, msg.item_list
                                );
                                continue;
                            }
                            let sender_id = msg
                                .from_user_id
                                .clone()
                                .unwrap_or_else(|| "unknown".to_string());

                            // Cache context token
                            if let Some(ct) = &msg.context_token {
                                self.context_tokens
                                    .write()
                                    .await
                                    .insert(sender_id.clone(), ct.clone());
                                // Persist context_token to config on disk
                                {
                                    let mut cfg = self.config.write().await;
                                    cfg.context_tokens.insert(sender_id.clone(), ct.clone());
                                }
                                self.persist_context_tokens().await;
                            }

                            let preview: String = text.chars().take(50).collect();
                            println!("[WeChat] Message from {}: {}...", sender_id, preview);

                            // Forward to OpenCode session
                            let gateway = self.clone();
                            let text_clone = text.clone();
                            let sender_clone = sender_id.clone();
                            tokio::spawn(async move {
                                if let Err(e) = gateway
                                    .handle_incoming_message(&sender_clone, &text_clone)
                                    .await
                                {
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
                        tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_DELAY_MS))
                            .await;
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

        let trimmed = text.trim();

        // Forward /answer to OpenCode pending question (must run before generic slash handler)
        if let Some(answer_text) = super::PendingQuestionStore::parse_answer_command(trimmed) {
            if let Some(qid) = self.pending_questions.try_answer(answer_text).await {
                println!(
                    "[WeChat] Question {} answered via /answer: {}",
                    qid, answer_text
                );
                let _ = self
                    .send_to_user(sender_id, &format!("✓ 已提交：{}", answer_text))
                    .await;
            } else {
                let _ = self.send_to_user(sender_id, "当前没有待回答的问题。").await;
            }
            return Ok(());
        }

        // Check for slash commands first
        if !trimmed.is_empty() && trimmed.starts_with('/') {
            let reply = self.handle_slash_command(&session_key, trimmed).await;
            let _ = self.send_to_user(sender_id, &reply).await;
            return Ok(());
        }

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
                Box::pin(async move { gateway.process_and_reply(&sender_id, &text).await })
                    as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
            })
                as Box<
                    dyn FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
                        + Send,
                >
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
                })
                    as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
            })
                as Box<
                    dyn FnOnce(
                            RejectReason,
                        )
                            -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
                        + Send,
                >)
        };

        let queued = QueuedMessage {
            enqueued_at: std::time::Instant::now(),
            process_fn,
            notify_fn,
        };

        match self.session_queue.enqueue(&session_key, queued).await {
            EnqueueResult::Processing => {}
            EnqueueResult::Queued { position } => {
                println!(
                    "[WeChat] Message queued at position {} for {}",
                    position, session_key
                );
            }
            EnqueueResult::Full => {
                eprintln!("[WeChat] Message queue full for {}", session_key);
            }
        }

        Ok(())
    }

    async fn handle_slash_command(&self, session_key: &str, content: &str) -> String {
        let parts: Vec<&str> = content.splitn(2, ' ').collect();
        let cmd = parts[0].to_lowercase();
        let arg = parts.get(1).copied().unwrap_or("").trim();

        match cmd.as_str() {
            "/help" => {
                "Available commands:\n/help - Show this help\n/model [name] - List or switch models\n/sessions [id] - List or bind sessions\n/reset - Start new session\n/stop - Stop current processing\n/answer - Reply to an AI clarification (see bot message)".to_string()
            }
            "/reset" => {
                self.session_mapping.remove_session(session_key).await;
                "Session reset. Next message will start a new conversation.".to_string()
            }
            "/model" => {
                super::handle_model_command(
                    self.opencode_port,
                    &self.session_mapping,
                    session_key,
                    arg,
                )
                .await
            }
            "/sessions" => {
                super::handle_sessions_command(
                    self.opencode_port,
                    &self.session_mapping,
                    session_key,
                    arg,
                )
                .await
            }
            "/stop" => {
                super::handle_stop_command(
                    self.opencode_port,
                    &self.session_mapping,
                    session_key,
                )
                .await
            }
            _ => format!("Unknown command: {}\nType /help for available commands.", cmd),
        }
    }

    async fn process_and_reply(&self, sender_id: &str, text: &str) {
        // Get or create session
        let session_key = format!("wechat:dm:{}", sender_id);
        let session_id = match self.session_mapping.get_session(&session_key).await {
            Some(id) => id,
            None => match super::create_opencode_session(self.opencode_port).await {
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
            },
        };

        // Get model preference for this session key
        let model = {
            let model_str = self.session_mapping.get_model(&session_key).await;
            model_str.and_then(|s| super::parse_model_preference(&s))
        };

        // Use unified gateway with SSE + permission auto-approval
        let parts = vec![serde_json::json!({ "type": "text", "text": text })];
        println!(
            "[WeChat] Sending to session {} via unified gateway",
            session_id
        );

        let pending_questions = Arc::clone(&self.pending_questions);
        let sender_for_q = sender_id.to_string();
        let gateway_for_q = self.clone();
        let question_ctx = super::QuestionContext {
            forwarder: Box::new(move |fq: super::ForwardedQuestion| {
                let gateway = gateway_for_q.clone();
                let sid = sender_for_q.clone();
                Box::pin(async move {
                    let text = super::format_question_message(&fq.questions, &fq.question_id);
                    gateway.send_to_user(&sid, &text).await?;
                    Ok(uuid::Uuid::new_v4().to_string())
                })
            }),
            store: pending_questions,
        };

        // Build sender identity for message prefix
        let channel_sender = super::ChannelSender {
            platform: "wechat".to_string(),
            external_id: sender_id.to_string(),
            display_name: sender_id.to_string(),
        };

        match super::send_message_async_with_approval(
            self.opencode_port,
            &session_id,
            parts,
            model,
            Some(question_ctx),
            Some(&channel_sender),
        )
        .await
        {
            Ok(response) => {
                let reply = if response.trim().is_empty() {
                    "模型未返回文字内容，请稍后重试或换种说法。".to_string()
                } else {
                    response
                };
                let _ = self.send_to_user(sender_id, &reply).await;
            }
            Err(e) => {
                eprintln!("[WeChat] Unified gateway error: {}", e);
                let _ = self.send_to_user(sender_id, &format!("Error: {}", e)).await;
            }
        }
    }
}
