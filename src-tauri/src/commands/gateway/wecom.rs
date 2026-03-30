use super::session::SessionMapping;
use super::wecom_config::{WeComConfig, WeComGatewayStatus, WeComGatewayStatusResponse};
use futures_util::stream::SplitSink;
#[allow(unused_imports)]
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, RwLock};
use std::sync::OnceLock;

/// Global reference to the active WeComGateway for proactive message sending.
static ACTIVE_GATEWAY: OnceLock<Arc<RwLock<Option<WeComGateway>>>> = OnceLock::new();

fn get_active_gateway_holder() -> &'static Arc<RwLock<Option<WeComGateway>>> {
    ACTIVE_GATEWAY.get_or_init(|| Arc::new(RwLock::new(None)))
}

/// Detect image MIME type from file magic bytes
fn detect_image_mime(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 4 {
        return None;
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg".into())
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some("image/png".into())
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif".into())
    } else if bytes.starts_with(b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WEBP" {
        Some("image/webp".into())
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp".into())
    } else {
        None
    }
}

type WsSink = Arc<
    tokio::sync::Mutex<
        SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            tokio_tungstenite::tungstenite::Message,
        >,
    >,
>;

pub const WECOM_WS_ENDPOINT: &str = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_INTERVAL_SECS: u64 = 30;
#[allow(dead_code)]
const HEARTBEAT_TIMEOUT_SECS: u64 = 6;
use super::session_queue::{EnqueueResult, QueuedMessage, RejectReason, SessionQueue};
use super::{ProcessedMessageTracker, MAX_PROCESSED_MESSAGES};

#[derive(Clone)]
pub struct WeComGateway {
    config: Arc<RwLock<WeComConfig>>,
    session_mapping: SessionMapping,
    opencode_port: u16,
    #[allow(dead_code)]
    workspace_path: String,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<WeComGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    processed_messages: Arc<RwLock<ProcessedMessageTracker>>,
    #[allow(dead_code)]
    permission_approver: super::PermissionAutoApprover,
    session_queue: Arc<SessionQueue>,
    pending_questions: Arc<super::PendingQuestionStore>,
    shared_ws_sink: Arc<RwLock<Option<WsSink>>>,
    card_metadata: Arc<RwLock<std::collections::HashMap<String, CardMetadata>>>,
}

#[derive(Debug, Clone, Deserialize)]
struct WeComWsMessage {
    #[serde(default)]
    cmd: String,
    #[allow(dead_code)]
    headers: Option<serde_json::Value>,
    body: Option<serde_json::Value>,
}

/// WeCom uses flat lowercase field names (msgid, chatid, msgtype, etc.)
/// See: https://developer.work.weixin.qq.com/document/path/101463
#[derive(Debug, Clone, Deserialize)]
struct WeComMsgCallback {
    #[serde(default)]
    msgid: String,
    #[serde(default)]
    chatid: String,
    #[serde(default)]
    chattype: String,
    #[serde(default)]
    from: Option<WeComFrom>,
    #[serde(default)]
    msgtype: String,
    // Content fields per msgtype
    #[serde(default)]
    text: Option<serde_json::Value>,
    #[serde(default)]
    voice: Option<serde_json::Value>,
    #[serde(default)]
    image: Option<serde_json::Value>,
    #[serde(default)]
    file: Option<serde_json::Value>,
    /// Quoted/referenced message when user replies to a message
    #[serde(default)]
    quote: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct WeComFrom {
    #[serde(default)]
    userid: String,
}

/// Metadata stored when a template card is sent for a question,
/// needed to update the card when the user clicks a button.
#[derive(Debug, Clone)]
struct CardMetadata {
    question_text: String,
    options: Vec<super::pending_question::QuestionOption>,
    req_id: String,
}

enum WsExitReason {
    Shutdown,
    Disconnected,
}

impl WeComGateway {
    pub fn new(opencode_port: u16, session_mapping: SessionMapping, workspace_path: String) -> Self {
        Self {
            config: Arc::new(RwLock::new(WeComConfig::default())),
            session_mapping,
            opencode_port,
            workspace_path,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(WeComGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            processed_messages: Arc::new(RwLock::new(ProcessedMessageTracker::new(
                MAX_PROCESSED_MESSAGES,
            ))),
            permission_approver: super::PermissionAutoApprover::new(opencode_port),
            session_queue: Arc::new(SessionQueue::new()),
            pending_questions: Arc::new(super::PendingQuestionStore::new()),
            shared_ws_sink: Arc::new(RwLock::new(None)),
            card_metadata: Arc::new(RwLock::new(std::collections::HashMap::new())),
        }
    }

    pub async fn set_config(&self, config: WeComConfig) {
        *self.config.write().await = config;
    }

    pub async fn get_status(&self) -> WeComGatewayStatusResponse {
        self.status.read().await.clone()
    }

    async fn set_status(&self, status: WeComGatewayStatus, error: Option<String>) {
        let mut s = self.status.write().await;
        s.status = status;
        s.error_message = error;
    }

    pub async fn start(&self) -> Result<(), String> {
        let is_running = *self.is_running.read().await;
        if is_running {
            return Err("WeCom gateway is already running".to_string());
        }

        let config = self.config.read().await.clone();
        if config.bot_id.is_empty() || config.secret.is_empty() {
            return Err("WeCom bot_id and secret are required".to_string());
        }

        *self.is_running.write().await = true;
        *get_active_gateway_holder().write().await = Some(self.clone());
        self.set_status(WeComGatewayStatus::Connecting, None).await;

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        let gateway = self.clone();
        let bot_id = config.bot_id.clone();
        let secret = config.secret.clone();

        tokio::spawn(async move {
            gateway.run_gateway_loop(bot_id, secret, shutdown_rx).await;
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let shutdown_tx = self.shutdown_tx.write().await.take();
        if let Some(tx) = shutdown_tx {
            let _ = tx.send(());
        }
        self.session_queue.shutdown().await;
        *get_active_gateway_holder().write().await = None;
        *self.shared_ws_sink.write().await = None;
        *self.is_running.write().await = false;
        self.set_status(WeComGatewayStatus::Disconnected, None)
            .await;
        Ok(())
    }

    async fn run_gateway_loop(
        &self,
        bot_id: String,
        secret: String,
        mut shutdown_rx: oneshot::Receiver<()>,
    ) {
        let mut backoff_secs = 2u64;

        loop {
            match self
                .connect_and_run(&bot_id, &secret, &mut shutdown_rx)
                .await
            {
                Ok(WsExitReason::Shutdown) => {
                    println!("[WeCom] Gateway shut down gracefully");
                    break;
                }
                Ok(WsExitReason::Disconnected) => {
                    backoff_secs = 2; // Reset after successful session
                    eprintln!("[WeCom] Disconnected, reconnecting in {}s", backoff_secs);
                    self.set_status(WeComGatewayStatus::Connecting, None).await;
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                        _ = &mut shutdown_rx => {
                            println!("[WeCom] Shutdown during reconnect backoff");
                            break;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[WeCom] Gateway error: {}", e);
                    self.set_status(WeComGatewayStatus::Error, Some(e)).await;
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                        _ = &mut shutdown_rx => {
                            println!("[WeCom] Shutdown during error backoff");
                            break;
                        }
                    }
                    backoff_secs = (backoff_secs * 2).min(60);
                }
            }
        }

        *self.is_running.write().await = false;
        *get_active_gateway_holder().write().await = None;
        self.set_status(WeComGatewayStatus::Disconnected, None)
            .await;
    }

    async fn connect_and_run(
        &self,
        bot_id: &str,
        secret: &str,
        shutdown_rx: &mut oneshot::Receiver<()>,
    ) -> Result<WsExitReason, String> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::connect_async;

        println!("[WeCom] Connecting to {}", WECOM_WS_ENDPOINT);

        let (ws_stream, _) = connect_async(WECOM_WS_ENDPOINT)
            .await
            .map_err(|e| format!("WebSocket connect failed: {}", e))?;

        let (mut ws_sink, mut ws_stream) = ws_stream.split();

        // Send aibot_subscribe
        let subscribe_msg = serde_json::json!({
            "cmd": "aibot_subscribe",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": { "bot_id": bot_id, "secret": secret }
        });
        ws_sink
            .send(tokio_tungstenite::tungstenite::Message::Text(
                subscribe_msg.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send subscribe: {}", e))?;

        // Wait for subscribe response (5s timeout)
        let subscribe_response =
            tokio::time::timeout(std::time::Duration::from_secs(5), ws_stream.next())
                .await
                .map_err(|_| "Subscribe response timeout".to_string())?
                .ok_or("WebSocket closed before subscribe response")?
                .map_err(|e| format!("Subscribe response error: {}", e))?;

        if let tokio_tungstenite::tungstenite::Message::Text(text) = subscribe_response {
            let resp: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("Invalid subscribe response: {}", e))?;
            // WeCom API uses "errcode"/"errmsg" fields (not "code"/"msg")
            let code = resp.get("errcode").and_then(|c| c.as_i64()).unwrap_or(-1);
            if code != 0 {
                let msg = resp
                    .get("errmsg")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("Subscribe failed (code {}): {}", code, msg));
            }
            println!("[WeCom] Subscribed successfully");
        }

        self.set_status(WeComGatewayStatus::Connected, None).await;
        {
            let mut s = self.status.write().await;
            s.bot_id = Some(bot_id.to_string());
        }

        // Heartbeat task
        let ws_sink = Arc::new(tokio::sync::Mutex::new(ws_sink));
        *self.shared_ws_sink.write().await = Some(Arc::clone(&ws_sink));
        let ws_sink_hb = Arc::clone(&ws_sink);
        let (hb_shutdown_tx, mut hb_shutdown_rx) = mpsc::channel::<()>(1);

        let heartbeat_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS)) => {
                        use futures_util::SinkExt;
                        let ping_json = serde_json::json!({
                            "cmd": "ping",
                            "headers": { "req_id": uuid::Uuid::new_v4().to_string() }
                        });
                        let ping = tokio_tungstenite::tungstenite::Message::Text(
                            ping_json.to_string().into(),
                        );
                        if let Err(e) = ws_sink_hb.lock().await.send(ping).await {
                            eprintln!("[WeCom] Heartbeat ping failed: {}", e);
                            break;
                        }
                    }
                    _ = hb_shutdown_rx.recv() => {
                        break;
                    }
                }
            }
        });

        // Main event loop
        let exit_reason = loop {
            tokio::select! {
                msg = ws_stream.next() => {
                    match msg {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                            let ws_sink_clone = Arc::clone(&ws_sink);
                            // Spawn message handling as a separate task so we don't block the WS loop
                            // (same pattern as Feishu gateway)
                            let gateway = self.clone();
                            tokio::spawn(async move {
                                gateway.handle_ws_message(&text, ws_sink_clone).await;
                            });
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Pong(_))) => {
                            // Heartbeat pong received
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => {
                            println!("[WeCom] WebSocket closed by server");
                            break WsExitReason::Disconnected;
                        }
                        Some(Err(e)) => {
                            eprintln!("[WeCom] WebSocket error: {}", e);
                            break WsExitReason::Disconnected;
                        }
                        None => {
                            println!("[WeCom] WebSocket stream ended");
                            break WsExitReason::Disconnected;
                        }
                        _ => {} // Ignore binary, etc.
                    }
                }
                _ = &mut *shutdown_rx => {
                    println!("[WeCom] Shutdown signal received");
                    break WsExitReason::Shutdown;
                }
            }
        };

        *self.shared_ws_sink.write().await = None;
        let _ = hb_shutdown_tx.send(()).await;
        heartbeat_handle.abort();
        Ok(exit_reason)
    }

    async fn handle_ws_message(&self, text: &str, ws_sink: WsSink) {
        let msg: WeComWsMessage = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[WeCom] Failed to parse message: {}", e);
                return;
            }
        };

        match msg.cmd.as_str() {
            "aibot_msg_callback" => {
                println!(
                    "[WeCom] Received msg callback: {}",
                    text.chars().take(2000).collect::<String>()
                );
                if let Some(body) = msg.body {
                    let callback: WeComMsgCallback = match serde_json::from_value(body) {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[WeCom] Failed to parse callback: {}", e);
                            return;
                        }
                    };
                    // Extract original req_id for reply
                    let req_id = msg
                        .headers
                        .as_ref()
                        .and_then(|h| h.get("req_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    self.handle_message_callback(callback, req_id, ws_sink)
                        .await;
                }
            }
            "aibot_event_callback" => {
                println!(
                    "[WeCom] Received event callback: {}",
                    text.chars().take(500).collect::<String>()
                );
                if let Some(body) = msg.body {
                    let eventtype = body
                        .get("event")
                        .and_then(|e| e.get("eventtype"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let req_id = msg
                        .headers
                        .as_ref()
                        .and_then(|h| h.get("req_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    match eventtype {
                        "enter_chat" => {
                            self.handle_enter_chat(&req_id, &ws_sink).await;
                        }
                        "template_card_event" => {
                            self.handle_template_card_event(&body, &req_id, &ws_sink).await;
                        }
                        "disconnected_event" => {
                            println!("[WeCom] Disconnected by server (new connection established)");
                        }
                        "feedback_event" => {
                            let feedback = body.get("event")
                                .and_then(|e| e.get("feedback"))
                                .and_then(|f| f.as_str())
                                .unwrap_or("unknown");
                            println!("[WeCom] User feedback received: {}", feedback);
                        }
                        _ => {
                            println!("[WeCom] Unhandled event type: {}", eventtype);
                        }
                    }
                }
            }
            "" => {
                // WeCom acknowledgment response — only log errors
                if let Some(body) = &msg.body {
                    let errcode = body.get("errcode").and_then(|c| c.as_i64()).unwrap_or(0);
                    if errcode != 0 {
                        let errmsg = body.get("errmsg").and_then(|m| m.as_str()).unwrap_or("");
                        eprintln!("[WeCom] Response error: code={}, msg={}", errcode, errmsg);
                    }
                }
                // Also check top-level errcode (WeCom puts it outside body)
                let raw: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
                let errcode = raw.get("errcode").and_then(|c| c.as_i64()).unwrap_or(0);
                if errcode != 0 {
                    let errmsg = raw.get("errmsg").and_then(|m| m.as_str()).unwrap_or("");
                    eprintln!("[WeCom] Response error: code={}, msg={}", errcode, errmsg);
                }
            }
            _ => {
                println!("[WeCom] Unhandled command: {}", msg.cmd);
            }
        }
    }

    async fn handle_message_callback(
        &self,
        msg: WeComMsgCallback,
        req_id: String,
        ws_sink: WsSink,
    ) {
        let userid = msg.from.as_ref().map(|f| f.userid.as_str()).unwrap_or("");
        println!(
            "[WeCom] Callback: msgid={}, msgtype={}, chattype={}, userid={}",
            msg.msgid, msg.msgtype, msg.chattype, userid
        );
        // Deduplication
        if !self.mark_message_processed(&msg.msgid).await {
            return;
        }

        // Extract content based on msgtype
        // WeCom puts content in type-specific fields: text.content, voice.content, image.url, etc.
        let mut text_content = String::new();
        let mut image_url: Option<String> = None;

        match msg.msgtype.as_str() {
            "text" => {
                text_content = msg
                    .text
                    .as_ref()
                    .and_then(|t| t.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            "voice" => {
                text_content = msg
                    .voice
                    .as_ref()
                    .and_then(|v| v.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            "image" => {
                println!("[WeCom] Image message body: {:?}", msg.image);
                image_url = msg
                    .image
                    .as_ref()
                    .and_then(|i| {
                        // Try "url" first, then "img_url", then "pic_url"
                        i.get("url")
                            .or_else(|| i.get("img_url"))
                            .or_else(|| i.get("pic_url"))
                    })
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if image_url.is_none() {
                    println!("[WeCom] Image message has no URL field");
                    return;
                }
            }
            "file" => {
                println!("[WeCom] File message body: {:?}", msg.file);
                let file_url = msg
                    .file
                    .as_ref()
                    .and_then(|f| f.get("url"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if file_url.is_none() {
                    println!("[WeCom] File message has no URL field");
                    return;
                }
                // Treat file like image — download and send as data URL
                image_url = file_url;
            }
            _ => {
                println!("[WeCom] Unsupported message type: {}", msg.msgtype);
                return;
            }
        };

        // Strip @mention prefix in group messages (e.g. "@蕉你一手 /help" → "/help")
        if msg.chattype == "group" && !text_content.is_empty() {
            if let Some(stripped) = text_content.trim().strip_prefix('@') {
                // Find end of mention (first space after @name)
                if let Some(space_pos) = stripped.find(' ') {
                    text_content = stripped[space_pos..].trim().to_string();
                }
                // If no space found, the entire message is just "@botname" with no content
            }
        }

        // Extract quoted/referenced message content
        // WeCom puts quoted messages in a "quote" field with structure:
        //   { "msgtype": "text", "text": { "content": "..." } }
        if let Some(ref quote) = msg.quote {
            let quoted_text = quote
                .get("text")
                .and_then(|t| t.get("content"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            // Check for question marker in quoted text
            if let Some(qid) = super::extract_question_marker(quoted_text) {
                if let Some(entry) = self.pending_questions.take_by_question_id(qid).await {
                    let _ = entry.answer_tx.send(text_content.clone());
                    println!(
                        "[WeCom] Question {} answered via quote reply",
                        entry.question_id
                    );
                    return;
                }
            }

            // Original behavior: prepend quoted text for context
            if !quoted_text.is_empty() {
                text_content = format!(
                    "[Quoted message]\n{}\n[End quoted message]\n\n{}",
                    quoted_text, text_content
                );
            }
        }

        if text_content.trim().is_empty() && image_url.is_none() {
            return;
        }

        // Session key
        let session_key = if msg.chattype == "single" {
            format!("wecom:dm:{}", userid)
        } else {
            format!("wecom:{}", msg.chatid)
        };

        // Check for /answer command — routes reply to the most recent pending question
        if let Some(answer_text) = super::PendingQuestionStore::parse_answer_command(&text_content)
        {
            if let Some(qid) = self.pending_questions.try_answer(answer_text).await {
                println!(
                    "[WeCom] Question {} answered via /answer: {}",
                    qid, answer_text
                );
                let _ = self
                    .send_reply(&req_id, &format!("✓ 已回复: {}", answer_text), &ws_sink)
                    .await;
            } else {
                let _ = self
                    .send_reply(&req_id, "当前没有待回复的问题", &ws_sink)
                    .await;
            }
            return;
        }

        // Check for slash commands (text only)
        let trimmed = text_content.trim();
        if !trimmed.is_empty() && trimmed.starts_with('/') {
            if let Err(e) = self
                .handle_slash_command(&session_key, trimmed, &msg, &req_id, &ws_sink)
                .await
            {
                eprintln!("[WeCom] Slash command error: {}", e);
            }
            return;
        }

        // Process message through OpenCode (via per-session queue)
        let gateway = self.clone();
        let session_key_owned = session_key.clone();
        let text_content_owned = text_content.clone();
        let image_url_owned = image_url.clone();
        let msg_owned = msg.clone();
        let req_id_owned = req_id.clone();
        let ws_sink_owned = Arc::clone(&ws_sink);

        // Clone again for notify_fn closure
        let gateway2 = self.clone();
        let req_id2 = req_id.clone();
        let ws_sink2 = Arc::clone(&ws_sink);

        // Build question context for forwarding AI questions back to WeCom
        // NOTE: The forwarder does NOT send to WeCom here — the SSE loop handles
        // display on the existing stream (same stream_id, finish=false) to avoid
        // prematurely closing the WeCom response. The forwarder only returns the
        // question_id so the store/channel setup works correctly.
        let pending_questions_clone = Arc::clone(&self.pending_questions);
        let question_ctx = super::QuestionContext {
            forwarder: Box::new(move |fq: super::ForwardedQuestion| {
                let qid = fq.question_id.clone();
                Box::pin(async move {
                    println!("[WeCom] Question registered: {}", qid);
                    Ok(qid)
                })
            }),
            store: pending_questions_clone,
        };

        let result = self
            .session_queue
            .enqueue(
                &session_key,
                QueuedMessage {
                    enqueued_at: std::time::Instant::now(),
                    process_fn: Box::new(move || {
                        Box::pin(async move {
                            let req_id_for_error = req_id_owned.clone();
                            if let Err(e) = gateway
                                .process_and_reply_with_parts(
                                    &session_key_owned,
                                    &text_content_owned,
                                    image_url_owned.as_deref(),
                                    &msg_owned,
                                    &req_id_owned,
                                    &ws_sink_owned,
                                    Some(&question_ctx),
                                )
                                .await
                            {
                                eprintln!("[WeCom] Process error: {}", e);
                                let _ = gateway
                                    .send_reply(
                                        &req_id_for_error,
                                        &format!("Error: {}", e),
                                        &ws_sink_owned,
                                    )
                                    .await;
                            }
                        })
                    }),
                    notify_fn: Some(Box::new(move |reason| {
                        Box::pin(async move {
                            let msg = match reason {
                                RejectReason::Timeout => "Your message timed out waiting in queue.",
                                RejectReason::QueueFull => {
                                    "Too many messages queued. Please try again later."
                                }
                                RejectReason::SessionClosed => {
                                    "Your message could not be processed. Please resend."
                                }
                            };
                            let _ = gateway2.send_reply(&req_id2, msg, &ws_sink2).await;
                        })
                    })),
                },
            )
            .await;

        match result {
            EnqueueResult::Queued { position } if position > 0 => {
                let _ = self
                    .send_reply(
                        &req_id,
                        &format!("Message queued (position: {}). Please wait...", position),
                        &ws_sink,
                    )
                    .await;
            }
            EnqueueResult::Full => { /* notify_fn already handled */ }
            _ => { /* Processing or Queued{0} — no feedback needed */ }
        }
    }

    async fn mark_message_processed(&self, msg_id: &str) -> bool {
        let mut tracker = self.processed_messages.write().await;
        !tracker.is_duplicate(msg_id)
    }

    async fn handle_slash_command(
        &self,
        session_key: &str,
        content: &str,
        _msg: &WeComMsgCallback,
        req_id: &str,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        let parts: Vec<&str> = content.splitn(2, ' ').collect();
        let cmd = parts[0].to_lowercase();
        let arg = parts.get(1).copied().unwrap_or("").trim();

        let reply = match cmd.as_str() {
            "/help" => {
                "Available commands:\n/help - Show this help\n/model [name] - List or switch models\n/sessions [id] - List or bind sessions\n/reset - Start new session\n/stop - Stop current processing".to_string()
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
            _ => format!("Unknown command: {}", cmd),
        };

        self.send_reply(req_id, &reply, ws_sink).await
    }

    /// Download image from URL and return as data URL + detected MIME type
    async fn download_image_as_data_url(&self, url: &str) -> Result<(String, String), String> {
        use base64::Engine as _;

        let client = reqwest::Client::new();
        let resp = client
            .get(url)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }

        // Detect MIME from Content-Type header or default to image/png
        let header_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .split(';')
            .next()
            .unwrap_or("image/png")
            .to_string();

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Failed to read body: {}", e))?;

        // If Content-Type is generic octet-stream, detect actual image type from magic bytes
        let content_type = if header_type == "application/octet-stream" {
            detect_image_mime(&bytes).unwrap_or_else(|| header_type)
        } else {
            header_type
        };

        println!(
            "[WeCom] Downloaded image: {} bytes, mime={}",
            bytes.len(),
            content_type
        );

        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let data_url = format!("data:{};base64,{}", content_type, b64);

        Ok((data_url, content_type))
    }

    async fn create_opencode_session(&self) -> Result<String, String> {
        super::create_opencode_session(self.opencode_port).await
    }

    async fn process_and_reply_with_parts(
        &self,
        session_key: &str,
        message: &str,
        image_url: Option<&str>,
        original: &WeComMsgCallback,
        req_id: &str,
        ws_sink: &WsSink,
        question_ctx: Option<&super::QuestionContext>,
    ) -> Result<(), String> {
        // Extract sender identity from WeCom message
        let userid = original
            .from
            .as_ref()
            .map(|f| f.userid.as_str())
            .unwrap_or("unknown");
        let channel_sender = super::ChannelSender {
            platform: "wecom".to_string(),
            external_id: userid.to_string(),
            display_name: userid.to_string(),
        };

        // Get or create session
        let model = self.session_mapping.get_model(session_key).await;
        let model_tuple = model
            .as_ref()
            .and_then(|m| super::parse_model_preference(m));

        let session_id = match self.session_mapping.get_session(session_key).await {
            Some(id) => id,
            None => {
                let id = self.create_opencode_session().await?;
                self.session_mapping
                    .set_session(session_key.to_string(), id.clone())
                    .await;
                id
            }
        };

        // Build message parts
        let mut parts = Vec::new();
        if !message.trim().is_empty() {
            parts.push(serde_json::json!({
                "type": "text",
                "text": message,
            }));
        }
        if let Some(url) = image_url {
            // Download image from WeCom and convert to data URL
            match self.download_image_as_data_url(url).await {
                Ok((data_url, mime)) => {
                    if parts.is_empty() {
                        parts.push(serde_json::json!({
                            "type": "text",
                            "text": "请描述这张图片",
                        }));
                    }
                    parts.push(serde_json::json!({
                        "type": "file",
                        "url": data_url,
                        "mime": mime,
                    }));
                }
                Err(e) => {
                    println!("[WeCom] Failed to download image: {}", e);
                    // If there's no text either, send error as text
                    if parts.is_empty() {
                        parts.push(serde_json::json!({
                            "type": "text",
                            "text": format!("[用户发送了一张图片，但下载失败: {}]", e),
                        }));
                    }
                }
            }
        }

        if parts.is_empty() {
            return Err("No content to send".to_string());
        }

        // Inject sender identity prefix into the first text part
        for part in parts.iter_mut() {
            if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    let prefixed = format!(
                        "[{}/{}] {}",
                        channel_sender.display_name, channel_sender.platform, text
                    );
                    part["text"] = serde_json::Value::String(prefixed);
                }
                break;
            }
        }

        // Stream OpenCode response to WeCom (retry with new session if prompt_async fails)
        match self
            .stream_opencode_to_wecom(
                &session_id,
                parts.clone(),
                model_tuple.clone(),
                req_id,
                ws_sink,
                question_ctx,
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(e) if e.contains("prompt_async failed") => {
                // Session might be stale (e.g. OpenCode restarted), create a new one and retry
                println!(
                    "[WeCom] Prompt failed, recreating session and retrying: {}",
                    e
                );
                let new_id = self.create_opencode_session().await?;
                self.session_mapping
                    .set_session(session_key.to_string(), new_id.clone())
                    .await;
                self.stream_opencode_to_wecom(
                    &new_id,
                    parts,
                    model_tuple,
                    req_id,
                    ws_sink,
                    question_ctx,
                )
                .await
            }
            Err(e) => Err(e),
        }
    }

    /// Stream OpenCode SSE events directly to WeCom as stream chunks
    async fn stream_opencode_to_wecom(
        &self,
        session_id: &str,
        parts: Vec<serde_json::Value>,
        model: Option<(String, String)>,
        req_id: &str,
        ws_sink: &WsSink,
        question_ctx: Option<&super::QuestionContext>,
    ) -> Result<(), String> {
        use futures_util::StreamExt as _;

        let port = self.opencode_port;
        let client = reqwest::Client::new();
        let mut stream_id = uuid::Uuid::new_v4().to_string();

        // Start thinking animation IMMEDIATELY (before prompt_async / SSE setup)
        // State: 0 = running, 1 = paused, 2 = stopped
        let (thinking_ctl_tx, thinking_ctl_rx) = tokio::sync::watch::channel(0u8);
        let mut thinking_active = true;

        // Send first frame synchronously so it appears instantly
        let _ = self
            .send_stream_chunk(req_id, &stream_id, "thinking(0s).", false, ws_sink)
            .await;

        // Animated thinking: time in middle, 1-5 dots cycle at end
        // Each cycle round adds an extra invisible char to keep content growing
        // (WeCom only re-renders when content length increases)
        {
            let ws_sink_clone = Arc::clone(ws_sink);
            let req_id = req_id.to_string();
            let stream_id = stream_id.clone();
            let mut ctl_rx = thinking_ctl_rx;
            tokio::spawn(async move {
                let start = tokio::time::Instant::now();
                let mut tick = 1usize;
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
                        _ = ctl_rx.changed() => {
                            let state = *ctl_rx.borrow();
                            if state == 2 { break; } // stopped
                            if state == 1 {
                                // paused — wait until resumed or stopped
                                loop {
                                    if ctl_rx.changed().await.is_err() { return; }
                                    let s = *ctl_rx.borrow();
                                    if s == 0 { break; }   // resumed
                                    if s == 2 { return; }   // stopped
                                }
                                continue;
                            }
                        }
                    }
                    // Don't send frames while paused
                    if *ctl_rx.borrow() != 0 {
                        continue;
                    }

                    let elapsed = start.elapsed().as_secs();
                    let time = if elapsed >= 60 {
                        format!("{}m{}s", elapsed / 60, elapsed % 60)
                    } else {
                        format!("{}s", elapsed)
                    };
                    // 1-5 dots cycle, plus one "\u{200b}" (zero-width space) per full cycle to grow length
                    let dot_count = (tick % 5) + 1;
                    let zws_count = tick / 5;
                    let dots = ".".repeat(dot_count);
                    let zws = "\u{200b}".repeat(zws_count);
                    let frame = format!("thinking({}){}{}", time, dots, zws);
                    let _ = Self::send_stream_chunk_static(
                        &req_id,
                        &stream_id,
                        &frame,
                        false,
                        &ws_sink_clone,
                    )
                    .await;
                    tick += 1;
                }
            });
        }

        // Step 1: Connect to SSE FIRST (before sending message) to avoid missing delta events
        let sse_url = format!("http://127.0.0.1:{}/event", port);
        let response = client
            .get(&sse_url)
            .header("Accept", "text/event-stream")
            .timeout(std::time::Duration::from_secs(900))
            .send()
            .await
            .map_err(|e| {
                let _ = thinking_ctl_tx.send(2);
                format!("Failed to connect to SSE: {}", e)
            })?;

        // Step 2: Now send message async (SSE is already listening)
        let url = format!(
            "http://127.0.0.1:{}/session/{}/prompt_async",
            port, session_id
        );
        let mut body = serde_json::json!({ "parts": parts });
        if let Some((provider_id, model_id)) = model {
            body["model"] = serde_json::json!({
                "providerID": provider_id,
                "modelID": model_id
            });
        }

        let send_timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let resp = client
            .post(&url)
            .json(&body)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| {
                let _ = thinking_ctl_tx.send(2);
                format!("Failed to send async message: {}", e)
            })?;

        if !resp.status().is_success() {
            let _ = thinking_ctl_tx.send(2);
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "OpenCode prompt_async failed: HTTP {} - {}",
                status, body_text
            ));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let start_time = tokio::time::Instant::now();

        // Track accumulated text for streaming
        let mut accumulated_text = String::new();
        let mut last_send_len = 0usize;
        let mut last_send_time = tokio::time::Instant::now();

        // Track sessions for permission approval
        let mut tracked_sessions = std::collections::HashSet::new();
        tracked_sessions.insert(session_id.to_string());
        let mut approved_permission_ids = std::collections::HashSet::new();
        // Track whether we've seen activity for our message (delta or busy status)
        // so we can detect abort (idle after activity) vs spurious idle events
        let mut has_seen_activity = false;
        // When true, a question is pending user reply — idle is expected, not an abort
        let mut waiting_for_question = false;

        println!(
            "[Gateway-{}] Streaming AI response to WeCom",
            &session_id[..session_id.len().min(8)]
        );

        while let Some(chunk) = stream.next().await {
            if start_time.elapsed() > std::time::Duration::from_secs(900) {
                // Stop animation and send whatever we have as final
                if thinking_active {
                    let _ = thinking_ctl_tx.send(2);
                }
                if !accumulated_text.is_empty() {
                    let _ = self
                        .send_stream_chunk(req_id, &stream_id, &accumulated_text, true, ws_sink)
                        .await;
                }
                return Err("Timeout waiting for OpenCode response".to_string());
            }

            let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text);

            while let Some(pos) = buffer.find("\n\n") {
                let event_text = buffer[..pos].to_string();
                buffer = buffer[pos + 2..].to_string();

                if let Some(event) = super::parse_sse_event(&event_text) {
                    let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

                    let event_session_id = event
                        .get("properties")
                        .and_then(|p| {
                            p.get("sessionID")
                                .or_else(|| p.get("sessionId"))
                                .or_else(|| p.get("info").and_then(|info| info.get("sessionID")))
                                .or_else(|| p.get("part").and_then(|part| part.get("sessionID")))
                        })
                        .and_then(|s| s.as_str());

                    match event_type {
                        "session.created" => {
                            let new_session_id = event
                                .get("properties")
                                .and_then(|p| {
                                    p.get("sessionID")
                                        .or_else(|| p.get("info").and_then(|i| i.get("id")))
                                })
                                .and_then(|id| id.as_str());
                            let parent_id = event
                                .get("properties")
                                .and_then(|p| p.get("info").and_then(|i| i.get("parentID")))
                                .and_then(|p| p.as_str());
                            if parent_id == Some(session_id) {
                                if let Some(child_id) = new_session_id {
                                    tracked_sessions.insert(child_id.to_string());
                                }
                            }
                        }

                        "permission.asked" => {
                            let perm_session_id = event
                                .get("properties")
                                .and_then(|p| p.get("sessionID"))
                                .and_then(|s| s.as_str());
                            let perm_id = event
                                .get("properties")
                                .and_then(|p| p.get("id"))
                                .and_then(|id| id.as_str());

                            if let (Some(sess_id), Some(perm_id_str)) = (perm_session_id, perm_id) {
                                if tracked_sessions.contains(sess_id)
                                    && !approved_permission_ids.contains(perm_id_str)
                                {
                                    let port_clone = port;
                                    let perm_id_clone = perm_id_str.to_string();
                                    tokio::spawn(async move {
                                        let client = reqwest::Client::new();
                                        let url = format!(
                                            "http://127.0.0.1:{}/permission/{}/reply",
                                            port_clone, perm_id_clone
                                        );
                                        let _ = client
                                            .post(&url)
                                            .json(&serde_json::json!({"reply":"always"}))
                                            .send()
                                            .await;
                                    });
                                    approved_permission_ids.insert(perm_id_str.to_string());
                                }
                            }
                        }

                        "question.asked" => {
                            if let Some(ctx) = question_ctx {
                                waiting_for_question = true;
                                has_seen_activity = false;
                                // Stop thinking animation
                                if thinking_active {
                                    let _ = thinking_ctl_tx.send(1); // 1 = paused
                                }

                                let questions = super::parse_question_event(&event);
                                let question_id = event
                                    .get("properties")
                                    .and_then(|p| p.get("id"))
                                    .and_then(|id| id.as_str())
                                    .unwrap_or("")
                                    .to_string();

                                // For each question: if it has options, send a card; otherwise text
                                let mut any_card_sent = false;
                                for q in &questions {
                                    if !q.options.is_empty() {
                                        // Send template card with buttons
                                        let _ = self
                                            .send_question_card(
                                                req_id,
                                                &question_id,
                                                &q.question,
                                                &q.options,
                                                ws_sink,
                                            )
                                            .await;
                                        any_card_sent = true;
                                    } else {
                                        // Open-ended question — send as text
                                        let text = super::format_question_message(
                                            &[q.clone()],
                                            &question_id,
                                        );
                                        let _ = self
                                            .send_stream_chunk(
                                                req_id, &stream_id, &text, true, ws_sink,
                                            )
                                            .await;
                                    }
                                }

                                // Prepare new stream for post-question response
                                stream_id = uuid::Uuid::new_v4().to_string();
                                accumulated_text.clear();
                                last_send_len = 0;

                                println!(
                                    "[WeCom] Question displayed: {}, cards={}",
                                    question_id, any_card_sent
                                );

                                // Set up reply channel
                                let prefix = &session_id[..session_id.len().min(8)];
                                super::handle_question_event(
                                    ctx,
                                    &event,
                                    port,
                                    prefix,
                                    &tracked_sessions,
                                )
                                .await;
                            }
                            continue;
                        }

                        "question.answered" => {
                            waiting_for_question = false;
                            // Resume thinking animation after user answers
                            if thinking_active {
                                let _ = thinking_ctl_tx.send(0); // 0 = running
                            }
                            continue;
                        }

                        "message.part.delta" => {
                            if event_session_id != Some(session_id) {
                                continue;
                            }
                            // Extract delta text
                            if let Some(delta) = event
                                .get("properties")
                                .and_then(|p| p.get("delta"))
                                .and_then(|d| d.as_str())
                            {
                                let part_type = event
                                    .get("properties")
                                    .and_then(|p| p.get("type"))
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("");
                                // Only stream text content, skip thinking/reasoning
                                if part_type == "text_delta" || part_type == "text" {
                                    has_seen_activity = true;
                                    accumulated_text.push_str(delta);

                                    // On first real text, stop thinking animation and replace with actual content
                                    if thinking_active && last_send_len == 0 {
                                        thinking_active = false;
                                        let _ = thinking_ctl_tx.send(2);
                                        if let Err(e) = self
                                            .send_stream_chunk(
                                                req_id,
                                                &stream_id,
                                                &accumulated_text,
                                                false,
                                                ws_sink,
                                            )
                                            .await
                                        {
                                            eprintln!(
                                                "[WeCom] Failed to send first text chunk: {}",
                                                e
                                            );
                                        }
                                        last_send_len = accumulated_text.len();
                                        last_send_time = tokio::time::Instant::now();
                                        continue;
                                    }

                                    // Send intermediate chunk every 2s or 500 chars
                                    // (conservative to stay under WeCom's 30 msg/min rate limit)
                                    let since_last = last_send_time.elapsed();
                                    let new_chars = accumulated_text.len() - last_send_len;
                                    if since_last > std::time::Duration::from_secs(2)
                                        && new_chars > 10
                                        || new_chars > 500
                                    {
                                        if let Err(e) = self
                                            .send_stream_chunk(
                                                req_id,
                                                &stream_id,
                                                &accumulated_text,
                                                false,
                                                ws_sink,
                                            )
                                            .await
                                        {
                                            eprintln!("[WeCom] Failed to send stream chunk: {}", e);
                                        }
                                        last_send_len = accumulated_text.len();
                                        last_send_time = tokio::time::Instant::now();
                                    }
                                }
                            }
                        }

                        "message.updated" => {
                            if event_session_id != Some(session_id) {
                                continue;
                            }
                            if let Some(info) = event.get("properties").and_then(|p| p.get("info"))
                            {
                                let role = info.get("role").and_then(|r| r.as_str());
                                let created_time = info
                                    .get("time")
                                    .and_then(|t| t.get("created"))
                                    .and_then(|c| c.as_u64());
                                let completed_time = info
                                    .get("time")
                                    .and_then(|t| t.get("completed"))
                                    .and_then(|c| c.as_u64());
                                let finish_reason = info.get("finish").and_then(|f| f.as_str());
                                let msg_id =
                                    info.get("id").and_then(|id| id.as_str()).unwrap_or("?");

                                println!("[Gateway-{}] message.updated: role={:?}, created={:?}, completed={:?}, finish={:?}, msg={}, send_ts={}, waiting_q={}",
                                    &session_id[..session_id.len().min(8)], role, created_time, completed_time, finish_reason, msg_id, send_timestamp_ms, waiting_for_question);

                                // tool-calls: intermediate step, reset activity flag so
                                // the subsequent idle doesn't prematurely end the stream
                                if role == Some("assistant")
                                    && completed_time.is_some()
                                    && finish_reason == Some("tool-calls")
                                {
                                    has_seen_activity = false;
                                }

                                if role == Some("assistant")
                                    && created_time.map_or(false, |t| t >= send_timestamp_ms)
                                    && completed_time.is_some()
                                    && finish_reason != Some("tool-calls")
                                {
                                    println!("[Gateway-{}] Message completed, sending final stream chunk", &session_id[..session_id.len().min(8)]);

                                    // Stop thinking animation if still active
                                    if thinking_active {
                                        // No need to update thinking_active — this branch ends the stream processing
                                        let _ = thinking_ctl_tx.send(2);
                                    }

                                    // If we didn't get any streaming content, fetch the full message
                                    if accumulated_text.is_empty() {
                                        let msg_id =
                                            info.get("id").and_then(|id| id.as_str()).unwrap_or("");
                                        if let Ok(full_text) =
                                            super::fetch_message_content(port, session_id, msg_id)
                                                .await
                                        {
                                            accumulated_text = full_text;
                                        }
                                    }

                                    // Send final chunk
                                    let final_text = if accumulated_text.is_empty() {
                                        "(No response)".to_string()
                                    } else {
                                        accumulated_text
                                    };
                                    return self
                                        .send_stream_chunk(
                                            req_id,
                                            &stream_id,
                                            &final_text,
                                            true,
                                            ws_sink,
                                        )
                                        .await;
                                }
                            }
                        }

                        "session.status" | "session.idle" => {
                            if event_session_id != Some(session_id) {
                                continue;
                            }
                            let status_type = event
                                .get("properties")
                                .and_then(|p| p.get("status"))
                                .and_then(|s| s.get("type"))
                                .and_then(|t| t.as_str());
                            let is_busy = status_type == Some("busy");
                            let is_idle =
                                status_type == Some("idle") || event_type == "session.idle";

                            println!("[Gateway-{}] session.status: type={:?}, busy={}, idle={}, has_activity={}, waiting_q={}",
                                &session_id[..session_id.len().min(8)], status_type, is_busy, is_idle, has_seen_activity, waiting_for_question);

                            if is_busy {
                                has_seen_activity = true;
                            }

                            // Only treat idle as abort/completion if we've seen activity
                            // and we're not waiting for a question reply (idle is expected then)
                            if is_idle && has_seen_activity && !waiting_for_question {
                                println!(
                                    "[Gateway-{}] Session went idle (aborted?), finishing stream",
                                    &session_id[..8]
                                );

                                if thinking_active {
                                    let _ = thinking_ctl_tx.send(2);
                                }

                                let final_text = if accumulated_text.is_empty() {
                                    "(已终止)".to_string()
                                } else {
                                    accumulated_text
                                };
                                return self
                                    .send_stream_chunk(
                                        req_id,
                                        &stream_id,
                                        &final_text,
                                        true,
                                        ws_sink,
                                    )
                                    .await;
                            }
                        }

                        _ => {}
                    }
                }
            }
        }

        // SSE ended unexpectedly — stop animation and send whatever we have
        if thinking_active {
            let _ = thinking_ctl_tx.send(2);
        }
        if !accumulated_text.is_empty() {
            return self
                .send_stream_chunk(req_id, &stream_id, &accumulated_text, true, ws_sink)
                .await;
        }
        Err("SSE stream ended unexpectedly".to_string())
    }

    /// Handle enter_chat event — send welcome message
    async fn handle_enter_chat(&self, req_id: &str, ws_sink: &WsSink) {
        use futures_util::SinkExt;

        let welcome = serde_json::json!({
            "cmd": "aibot_respond_welcome_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "text",
                "text": {
                    "content": "你好！我是 AI 助手。直接发消息给我开始对话，发送 /help 查看可用命令。"
                }
            }
        });

        match ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                welcome.to_string().into(),
            ))
            .await
        {
            Ok(_) => println!("[WeCom] Welcome message sent"),
            Err(e) => eprintln!("[WeCom] Failed to send welcome message: {}", e),
        }
    }

    /// Handle template_card_event — user clicked a button on a template card
    async fn handle_template_card_event(
        &self,
        body: &serde_json::Value,
        req_id: &str,
        ws_sink: &WsSink,
    ) {
        use futures_util::SinkExt;

        // Extract the clicked button key from the event
        let event = match body.get("event") {
            Some(e) => e,
            None => {
                eprintln!("[WeCom] Template card event missing 'event' field");
                return;
            }
        };

        let selected_key = event
            .get("selected_items")
            .and_then(|items| items.as_array())
            .and_then(|arr| arr.first())
            .and_then(|item| item.get("key"))
            .and_then(|k| k.as_str())
            .or_else(|| event.get("key").and_then(|k| k.as_str()))
            .unwrap_or("");

        if selected_key.is_empty() {
            println!("[WeCom] Template card event with no selected key");
            return;
        }

        println!("[WeCom] Template card button clicked: key={}", selected_key);

        // Parse key format: "q:{question_id}:{option_index}:{option_value}"
        let parts: Vec<&str> = selected_key.splitn(4, ':').collect();
        if parts.len() < 4 || parts[0] != "q" {
            println!("[WeCom] Unexpected button key format: {}", selected_key);
            return;
        }
        let question_id = parts[1];
        let option_index: usize = parts[2].parse().unwrap_or(0);
        let option_value = parts[3];

        // Answer the pending question
        if let Some(entry) = self.pending_questions.take_by_question_id(question_id).await {
            let _ = entry.answer_tx.send(option_value.to_string());
            println!("[WeCom] Question {} answered via card: {}", question_id, option_value);
        } else {
            println!("[WeCom] No pending question found for id={}", question_id);
        }

        // Update the card — highlight selected button, grey out others
        let metadata = self.card_metadata.write().await.remove(question_id);
        if let Some(meta) = metadata {
            let button_list: Vec<serde_json::Value> = meta
                .options
                .iter()
                .enumerate()
                .map(|(i, opt)| {
                    let value = opt.value.as_deref().unwrap_or(&opt.label);
                    let (text, style) = if i == option_index {
                        (format!("✓ {}", opt.label), 1) // highlighted
                    } else {
                        (opt.label.clone(), 2) // grey
                    };
                    serde_json::json!({
                        "text": text,
                        "style": style,
                        "key": format!("q:{}:{}:{}", question_id, i, value)
                    })
                })
                .collect();

            let task_id = format!("q:{}", question_id);

            let update_msg = serde_json::json!({
                "cmd": "aibot_respond_update_msg",
                "headers": { "req_id": req_id },
                "body": {
                    "response_type": "update_template_card",
                    "template_card": {
                        "card_type": "button_interaction",
                        "main_title": { "title": "AI Question" },
                        "sub_title_text": meta.question_text,
                        "button_list": button_list,
                        "task_id": task_id
                    }
                }
            });

            match ws_sink
                .lock()
                .await
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    update_msg.to_string().into(),
                ))
                .await
            {
                Ok(_) => println!("[WeCom] Card updated: task_id={}", task_id),
                Err(e) => eprintln!("[WeCom] Failed to update card: {}", e),
            }
        }
    }

    /// Send a template card with buttons for a question that has options.
    async fn send_question_card(
        &self,
        req_id: &str,
        question_id: &str,
        question_text: &str,
        options: &[super::pending_question::QuestionOption],
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let button_list: Vec<serde_json::Value> = options
            .iter()
            .enumerate()
            .map(|(i, opt)| {
                let value = opt.value.as_deref().unwrap_or(&opt.label);
                serde_json::json!({
                    "text": opt.label,
                    "style": 1,
                    "key": format!("q:{}:{}:{}", question_id, i, value)
                })
            })
            .collect();

        let task_id = format!("q:{}", question_id);

        let card_msg = serde_json::json!({
            "cmd": "aibot_respond_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "template_card",
                "template_card": {
                    "card_type": "button_interaction",
                    "main_title": { "title": "AI Question" },
                    "sub_title_text": question_text,
                    "button_list": button_list,
                    "task_id": task_id
                }
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                card_msg.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send question card: {}", e))?;

        // Store metadata for card update when button is clicked
        self.card_metadata.write().await.insert(
            question_id.to_string(),
            CardMetadata {
                question_text: question_text.to_string(),
                options: options.to_vec(),
                req_id: req_id.to_string(),
            },
        );

        println!("[WeCom] Question card sent: task_id={}", task_id);
        Ok(())
    }

    async fn send_stream_chunk(
        &self,
        req_id: &str,
        stream_id: &str,
        content: &str,
        finish: bool,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let reply = serde_json::json!({
            "cmd": "aibot_respond_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "stream",
                "stream": {
                    "id": stream_id,
                    "finish": finish,
                    "content": content,
                },
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                reply.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send reply: {}", e))
    }

    /// Static version of send_stream_chunk for use in spawned tasks (no &self needed)
    async fn send_stream_chunk_static(
        req_id: &str,
        stream_id: &str,
        content: &str,
        finish: bool,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let reply = serde_json::json!({
            "cmd": "aibot_respond_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "stream",
                "stream": {
                    "id": stream_id,
                    "finish": finish,
                    "content": content,
                },
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                reply.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send reply: {}", e))
    }

    /// Send a proactive message to a WeCom conversation via aibot_send_msg.
    /// Requires the gateway to be connected and the target user to have
    /// previously messaged the bot in that conversation.
    pub async fn send_chat_message(&self, chatid: &str, chat_type: u32, text: &str) -> Result<(), String> {
        use futures_util::SinkExt;

        let ws_sink = self
            .shared_ws_sink
            .read()
            .await
            .clone()
            .ok_or_else(|| {
                "WeCom gateway is not connected. Cannot send proactive message.".to_string()
            })?;

        let msg = serde_json::json!({
            "cmd": "aibot_send_msg",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": {
                "chatid": chatid,
                "chat_type": chat_type,
                "msgtype": "markdown",
                "markdown": { "content": text }
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                msg.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send proactive message: {}", e))?;

        println!("[WeCom] Proactive message sent to chatid={}, chat_type={}", chatid, chat_type);
        Ok(())
    }

    /// Simple non-streaming reply (for slash commands and errors)
    async fn send_reply(&self, req_id: &str, text: &str, ws_sink: &WsSink) -> Result<(), String> {
        let stream_id = uuid::Uuid::new_v4().to_string();
        self.send_stream_chunk(req_id, &stream_id, text, true, ws_sink)
            .await
    }
}

/// Send a proactive message to a WeCom conversation.
/// Called by cron delivery and other modules that don't have direct gateway access.
/// Requires the WeCom gateway to be running and connected.
pub async fn send_proactive_message(chatid: &str, chat_type: u32, text: &str) -> Result<(), String> {
    let gateway = get_active_gateway_holder()
        .read()
        .await
        .clone()
        .ok_or_else(|| {
            "WeCom gateway is not running. Start the WeCom gateway before sending proactive messages.".to_string()
        })?;

    gateway.send_chat_message(chatid, chat_type, text).await
}
