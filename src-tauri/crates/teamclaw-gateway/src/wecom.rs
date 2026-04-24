use crate::i18n;
use crate::session::SessionMapping;
use crate::wecom_config::{WeComConfig, WeComGatewayStatus, WeComGatewayStatusResponse};
use base64::Engine as _;
use futures_util::stream::SplitSink;
#[allow(unused_imports)]
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::{mpsc, oneshot, RwLock};

/// Global reference to the active WeComGateway for proactive message sending.
static ACTIVE_GATEWAY: OnceLock<Arc<RwLock<Option<WeComGateway>>>> = OnceLock::new();

fn get_active_gateway_holder() -> &'static Arc<RwLock<Option<WeComGateway>>> {
    ACTIVE_GATEWAY.get_or_init(|| Arc::new(RwLock::new(None)))
}

/// Decrypt AES-256-CBC encrypted data from WeCom.
/// WeCom images/files are encrypted with a per-message aeskey.
/// Algorithm: AES-256-CBC, PKCS#7 padding (32-byte aligned), IV = first 16 bytes of key.
fn decrypt_wecom_media(encrypted: &[u8], aeskey_b64: &str) -> Result<Vec<u8>, String> {
    use aes::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};

    type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

    // Base64-decode the key (may need padding)
    let padded_key = if aeskey_b64.ends_with('=') {
        aeskey_b64.to_string()
    } else {
        format!("{}=", aeskey_b64)
    };
    let key = base64::engine::general_purpose::STANDARD
        .decode(&padded_key)
        .map_err(|e| format!("Failed to decode aeskey: {}", e))?;

    if key.len() != 32 {
        return Err(format!("AES key must be 32 bytes, got {}", key.len()));
    }

    // IV = first 16 bytes of the key
    let iv = &key[..16];

    // Decrypt
    let mut buf = encrypted.to_vec();
    let decryptor =
        Aes256CbcDec::new_from_slices(&key, iv).map_err(|e| format!("AES init failed: {}", e))?;
    let decrypted = decryptor
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| format!("AES decryption failed: {:?}", e))?;

    // Manual PKCS#7 unpadding (32-byte aligned, values 1-32)
    if decrypted.is_empty() {
        return Err("Decrypted data is empty".into());
    }
    let pad_byte = *decrypted.last().unwrap() as usize;
    if pad_byte == 0 || pad_byte > 32 || pad_byte > decrypted.len() {
        // No valid padding — return as-is
        return Ok(decrypted.to_vec());
    }
    // Verify all padding bytes match
    let start = decrypted.len() - pad_byte;
    if decrypted[start..].iter().all(|&b| b as usize == pad_byte) {
        Ok(decrypted[..start].to_vec())
    } else {
        Ok(decrypted.to_vec())
    }
}

/// Compress an image to fit within max_bytes by resizing and re-encoding as JPEG.
fn compress_image(bytes: &[u8], max_bytes: usize) -> Result<Vec<u8>, String> {
    use image::ImageReader;
    use std::io::Cursor;

    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to guess image format: {}", e))?
        .decode()
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    // Try progressively smaller sizes until it fits
    let (orig_w, orig_h) = (img.width(), img.height());
    for scale_pct in &[100u32, 75, 50, 35, 25] {
        let w = orig_w * scale_pct / 100;
        let h = orig_h * scale_pct / 100;
        let resized = if *scale_pct < 100 {
            img.resize(w, h, image::imageops::FilterType::Lanczos3)
        } else {
            img.clone()
        };

        // Encode as JPEG with quality 80
        let mut buf = Cursor::new(Vec::new());
        resized
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .map_err(|e| format!("JPEG encode failed: {}", e))?;

        let result = buf.into_inner();
        if result.len() <= max_bytes {
            return Ok(result);
        }
    }

    Err("Could not compress image small enough".into())
}

/// Detect MIME type from file magic bytes
fn detect_mime_from_magic(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 4 {
        return None;
    }
    // Images
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
    // Documents
    } else if bytes.starts_with(b"%PDF") {
        Some("application/pdf".into())
    // MS Office (OOXML: docx, xlsx, pptx are ZIP archives)
    } else if bytes.starts_with(&[0x50, 0x4B, 0x03, 0x04]) {
        None // ZIP-based; need filename to distinguish docx/xlsx/pptx
    } else {
        None
    }
}

/// Infer MIME type from filename extension
fn detect_mime_from_filename(filename: &str) -> Option<String> {
    let ext = filename.rsplit('.').next()?.to_lowercase();
    match ext.as_str() {
        // Images
        "jpg" | "jpeg" => Some("image/jpeg".into()),
        "png" => Some("image/png".into()),
        "gif" => Some("image/gif".into()),
        "webp" => Some("image/webp".into()),
        "bmp" => Some("image/bmp".into()),
        "svg" => Some("image/svg+xml".into()),
        // Documents
        "pdf" => Some("application/pdf".into()),
        "doc" => Some("application/msword".into()),
        "docx" => {
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document".into())
        }
        "xls" => Some("application/vnd.ms-excel".into()),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into()),
        "ppt" => Some("application/vnd.ms-powerpoint".into()),
        "pptx" => {
            Some("application/vnd.openxmlformats-officedocument.presentationml.presentation".into())
        }
        "csv" => Some("text/csv".into()),
        "txt" => Some("text/plain".into()),
        "json" => Some("application/json".into()),
        "xml" => Some("application/xml".into()),
        "html" | "htm" => Some("text/html".into()),
        "md" => Some("text/markdown".into()),
        "zip" => Some("application/zip".into()),
        _ => None,
    }
}

/// Get platform code for WeCom QR auth API
fn get_plat_code() -> u8 {
    #[cfg(target_os = "macos")]
    {
        1
    }
    #[cfg(target_os = "windows")]
    {
        2
    }
    #[cfg(target_os = "linux")]
    {
        3
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        0
    }
}

const WECOM_QR_GENERATE_URL: &str = "https://work.weixin.qq.com/ai/qc/generate";
const WECOM_QR_POLL_URL: &str = "https://work.weixin.qq.com/ai/qc/query_result";

/// Fetch a QR code for WeCom bot authorization
pub async fn fetch_wecom_qr_code() -> Result<super::wecom_config::WeComQrAuthStart, String> {
    use crate::wecom_config::{WeComQrAuthStart, WeComQrGenerateResponse};

    let url = format!(
        "{}?source=teamclaw&plat={}",
        WECOM_QR_GENERATE_URL,
        get_plat_code()
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("QR generate request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("QR generate failed: HTTP {}", resp.status()));
    }

    let body: WeComQrGenerateResponse = resp
        .json()
        .await
        .map_err(|e| format!("QR generate parse failed: {}", e))?;

    let data = body.data.ok_or("QR generate response missing data")?;
    if data.scode.is_empty() || data.auth_url.is_empty() {
        return Err("QR generate response missing scode or auth_url".into());
    }

    Ok(WeComQrAuthStart {
        scode: data.scode,
        auth_url: data.auth_url,
    })
}

/// Poll WeCom QR code scan result
pub async fn poll_wecom_qr_result(
    scode: &str,
) -> Result<super::wecom_config::WeComQrAuthPollResult, String> {
    use crate::wecom_config::{WeComQrAuthPollResult, WeComQrPollResponse};

    let url = format!("{}?scode={}", WECOM_QR_POLL_URL, urlencoding::encode(scode));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("QR poll request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("QR poll failed: HTTP {}", resp.status()));
    }

    let body: WeComQrPollResponse = resp
        .json()
        .await
        .map_err(|e| format!("QR poll parse failed: {}", e))?;

    let data = match body.data {
        Some(d) => d,
        None => {
            return Ok(WeComQrAuthPollResult {
                status: "waiting".into(),
                bot_id: None,
                secret: None,
            });
        }
    };

    if data.status == "success" {
        let bot_info = data
            .bot_info
            .ok_or("QR poll success but missing bot_info")?;
        Ok(WeComQrAuthPollResult {
            status: "success".into(),
            bot_id: Some(bot_info.botid),
            secret: Some(bot_info.secret),
        })
    } else {
        Ok(WeComQrAuthPollResult {
            status: data.status,
            bot_id: None,
            secret: None,
        })
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
use crate::session_queue::{EnqueueResult, QueuedMessage, RejectReason, SessionQueue};
use crate::{ProcessedMessageTracker, MAX_PROCESSED_MESSAGES};

/// Pending WebSocket response channels, keyed by req_id.
/// Used for request–response patterns (e.g. media upload) over the multiplexed WS.
type PendingResponses =
    Arc<tokio::sync::Mutex<std::collections::HashMap<String, oneshot::Sender<serde_json::Value>>>>;

#[derive(Clone)]
pub struct WeComGateway {
    config: Arc<RwLock<WeComConfig>>,
    session_mapping: SessionMapping,
    opencode_port: u16,
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
    pending_responses: PendingResponses,
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
#[allow(dead_code)]
struct CardMetadata {
    question_text: String,
    options: Vec<super::pending_question::QuestionOption>,
}

enum WsExitReason {
    Shutdown,
    Disconnected,
}

impl WeComGateway {
    pub fn new(
        opencode_port: u16,
        session_mapping: SessionMapping,
        workspace_path: String,
    ) -> Self {
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
            pending_responses: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub async fn set_config(&self, config: WeComConfig) {
        *self.config.write().await = config;
    }

    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    pub fn opencode_port(&self) -> u16 {
        self.opencode_port
    }

    pub async fn get_status(&self) -> WeComGatewayStatusResponse {
        let mut resp = self.status.read().await.clone();
        // Populate active sessions from session mapping
        let data = self.session_mapping.get_all_sessions().await;
        resp.active_sessions = data
            .sessions
            .keys()
            .filter(|k| k.starts_with("wecom:"))
            .cloned()
            .collect();
        resp.active_sessions.sort();
        resp
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
                            self.handle_template_card_event(&body, &req_id, &ws_sink)
                                .await;
                        }
                        "disconnected_event" => {
                            println!("[WeCom] Disconnected by server (new connection established)");
                        }
                        "feedback_event" => {
                            let feedback = body
                                .get("event")
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
                // WeCom acknowledgment/response — route to pending waiters or log errors
                let raw: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
                let req_id = raw
                    .get("headers")
                    .and_then(|h| h.get("req_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // If someone is waiting for this req_id, deliver the response
                if !req_id.is_empty() {
                    let mut pending = self.pending_responses.lock().await;
                    if let Some(tx) = pending.remove(req_id) {
                        let _ = tx.send(raw.clone());
                        return;
                    }
                }

                // Otherwise log errors as before
                if let Some(body) = &msg.body {
                    let errcode = body.get("errcode").and_then(|c| c.as_i64()).unwrap_or(0);
                    if errcode != 0 {
                        let errmsg = body.get("errmsg").and_then(|m| m.as_str()).unwrap_or("");
                        eprintln!("[WeCom] Response error: code={}, msg={}", errcode, errmsg);
                    }
                }
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
        let mut filename_hint: Option<String> = None;
        let mut media_aeskey: Option<String> = None;

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
                // Extract per-message AES key for encrypted images
                media_aeskey = msg
                    .image
                    .as_ref()
                    .and_then(|i| i.get("aeskey"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
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
                // Extract filename for MIME detection fallback
                filename_hint = msg
                    .file
                    .as_ref()
                    .and_then(|f| f.get("filename"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                // Extract per-message AES key for encrypted files
                media_aeskey = msg
                    .file
                    .as_ref()
                    .and_then(|f| f.get("aeskey"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
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

        // Auto-record ownerId on first DM if not yet set
        if msg.chattype == "single" && !userid.is_empty() {
            let config = self.config.read().await;
            if config.owner_id.is_none() {
                drop(config);
                let mut config = self.config.write().await;
                // Double-check after acquiring write lock
                if config.owner_id.is_none() {
                    config.owner_id = Some(userid.to_string());
                    println!("[WeCom] Auto-recorded ownerId: {}", userid);
                    // Persist to config file
                    if let Ok(mut file_config) = super::read_config(&self.workspace_path) {
                        let channels = file_config
                            .channels
                            .get_or_insert_with(super::config::ChannelsConfig::default);
                        if let Some(ref mut wecom) = channels.wecom {
                            wecom.owner_id = Some(userid.to_string());
                        } else {
                            let mut wc = WeComConfig::default();
                            wc.owner_id = Some(userid.to_string());
                            channels.wecom = Some(wc);
                        }
                        let _ = super::write_config(&self.workspace_path, &file_config);
                    }
                }
            }
        }

        // Check for /answer command — routes reply to the most recent pending question
        if let Some(answer_text) = super::PendingQuestionStore::parse_answer_command(&text_content)
        {
            let locale = i18n::get_locale(&self.workspace_path);
            if let Some(qid) = self.pending_questions.try_answer(answer_text).await {
                println!(
                    "[WeCom] Question {} answered via /answer: {}",
                    qid, answer_text
                );
                let _ = self
                    .send_reply(
                        &req_id,
                        &i18n::t(i18n::MsgKey::AnswerSubmitted(answer_text), locale),
                        &ws_sink,
                    )
                    .await;
            } else {
                let _ = self
                    .send_reply(
                        &req_id,
                        &i18n::t(i18n::MsgKey::NoPendingQuestions, locale),
                        &ws_sink,
                    )
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
        let media_aeskey_owned = media_aeskey.clone();
        let filename_hint_owned = filename_hint.clone();
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
                                    media_aeskey_owned.as_deref(),
                                    filename_hint_owned.as_deref(),
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
                            let locale = i18n::get_locale(&gateway2.workspace_path);
                            let msg = match reason {
                                RejectReason::Timeout => {
                                    i18n::t(i18n::MsgKey::QueueTimeout, locale)
                                }
                                RejectReason::QueueFull => i18n::t(i18n::MsgKey::QueueFull, locale),
                                RejectReason::SessionClosed => {
                                    i18n::t(i18n::MsgKey::MessageCouldNotBeProcessed, locale)
                                }
                            };
                            let _ = gateway2.send_reply(&req_id2, &msg, &ws_sink2).await;
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
        let locale = i18n::get_locale(&self.workspace_path);

        let reply = match cmd.as_str() {
            "/help" => i18n::t(i18n::MsgKey::HelpWecom, locale),
            "/reset" => {
                self.session_mapping.remove_session(session_key).await;
                i18n::t(i18n::MsgKey::SessionReset, locale)
            }
            "/model" => {
                super::handle_model_command(
                    self.opencode_port,
                    &self.session_mapping,
                    session_key,
                    arg,
                    locale,
                )
                .await
            }
            "/sessions" => {
                super::handle_sessions_command(
                    self.opencode_port,
                    &self.session_mapping,
                    session_key,
                    arg,
                    locale,
                )
                .await
            }
            "/stop" => {
                super::handle_stop_command(
                    self.opencode_port,
                    &self.session_mapping,
                    session_key,
                    locale,
                )
                .await
            }
            _ => i18n::t(i18n::MsgKey::UnknownCommand(&cmd), locale),
        };

        self.send_reply(req_id, &reply, ws_sink).await
    }

    /// Download file from URL and return as data URL + detected MIME type.
    /// If `aeskey` is provided, the downloaded data is AES-256-CBC decrypted first.
    /// An optional filename hint is used to infer MIME when detection fails.
    /// Returns (data_url, mime_type, raw_bytes)
    async fn download_as_data_url(
        &self,
        url: &str,
        aeskey: Option<&str>,
        filename_hint: Option<&str>,
    ) -> Result<(String, String, Vec<u8>), String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let resp = client
            .get(url)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }

        let raw_bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Failed to read body: {}", e))?;

        // Decrypt if aeskey is provided (WeCom encrypts images/files with per-message AES key)
        let bytes: Vec<u8> = if let Some(key) = aeskey {
            println!("[WeCom] Decrypting {} bytes with aeskey", raw_bytes.len());
            decrypt_wecom_media(&raw_bytes, key)?
        } else {
            raw_bytes.to_vec()
        };

        // Detect MIME from magic bytes, then filename, then default to image/png
        let content_type = detect_mime_from_magic(&bytes)
            .or_else(|| filename_hint.and_then(detect_mime_from_filename))
            .unwrap_or_else(|| "image/png".to_string());

        println!(
            "[WeCom] Downloaded file: {} bytes (raw {}), mime={}, filename={:?}",
            bytes.len(),
            raw_bytes.len(),
            content_type,
            filename_hint
        );

        // Compress image if too large for AI model (limit ~258KB base64 → ~190KB raw)
        const MAX_RAW_BYTES: usize = 190_000;
        let (final_bytes, final_mime) =
            if bytes.len() > MAX_RAW_BYTES && content_type.starts_with("image/") {
                match compress_image(&bytes, MAX_RAW_BYTES) {
                    Ok(compressed) => {
                        println!(
                            "[WeCom] Compressed image: {} -> {} bytes",
                            bytes.len(),
                            compressed.len()
                        );
                        (compressed, "image/jpeg".to_string())
                    }
                    Err(e) => {
                        println!("[WeCom] Image compression failed, using original: {}", e);
                        (bytes.clone(), content_type.clone())
                    }
                }
            } else {
                (bytes.clone(), content_type.clone())
            };

        let b64 = base64::engine::general_purpose::STANDARD.encode(&final_bytes);
        let data_url = format!("data:{};base64,{}", final_mime, b64);

        Ok((data_url, final_mime, bytes))
    }

    async fn create_opencode_session(&self) -> Result<String, String> {
        super::create_opencode_session(self.opencode_port).await
    }

    async fn process_and_reply_with_parts(
        &self,
        session_key: &str,
        message: &str,
        image_url: Option<&str>,
        media_aeskey: Option<&str>,
        filename_hint: Option<&str>,
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
            // Download file from WeCom, decrypt if encrypted, and convert to data URL
            match self
                .download_as_data_url(url, media_aeskey, filename_hint)
                .await
            {
                Ok((data_url, mime, raw_bytes)) => {
                    // Save image to workspace so the UI can display it
                    let ext = mime.split('/').last().unwrap_or("png");
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis();
                    let img_filename = format!("wecom-{}.{}", ts, ext);
                    let uploads_dir = format!("{}/.uploads", self.workspace_path);
                    let _ = tokio::fs::create_dir_all(&uploads_dir).await;
                    let img_path = format!("{}/{}", uploads_dir, img_filename);
                    let attachment_ref = if tokio::fs::write(&img_path, &raw_bytes).await.is_ok() {
                        format!("[Attachment: {}] (path: {})", img_filename, img_path)
                    } else {
                        String::new()
                    };

                    // Build text: user text (or default) + attachment reference for UI display
                    let text_content = if parts.is_empty() {
                        if attachment_ref.is_empty() {
                            "请描述这张图片".to_string()
                        } else {
                            format!("请描述这张图片\n\n{}", attachment_ref)
                        }
                    } else {
                        // Append attachment ref to existing text
                        let existing = parts.pop().unwrap();
                        let existing_text =
                            existing.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if attachment_ref.is_empty() {
                            existing_text.to_string()
                        } else {
                            format!("{}\n\n{}", existing_text, attachment_ref)
                        }
                    };
                    parts.push(serde_json::json!({
                        "type": "text",
                        "text": text_content,
                    }));
                    parts.push(serde_json::json!({
                        "type": "file",
                        "url": data_url,
                        "mime": mime,
                    }));
                }
                Err(e) => {
                    println!("[WeCom] Failed to download file: {}", e);
                    // If there's no text either, send error as text
                    if parts.is_empty() {
                        parts.push(serde_json::json!({
                            "type": "text",
                            "text": format!("[用户发送了文件，但下载失败: {}]", e),
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
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
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
        let mut accumulated_reasoning = String::new();
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
                                        let client = reqwest::Client::builder()
                                            .timeout(std::time::Duration::from_secs(30))
                                            .build()
                                            .unwrap_or_else(|_| reqwest::Client::new());
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
                                // Stop thinking animation permanently (it holds the old stream_id)
                                if thinking_active {
                                    let _ = thinking_ctl_tx.send(2); // 2 = stopped
                                    thinking_active = false;
                                }
                                // Finish the current stream so WeCom closes it cleanly
                                {
                                    let finish_text = if accumulated_text.is_empty() {
                                        accumulated_reasoning.clone()
                                    } else {
                                        accumulated_text.clone()
                                    };
                                    let _ = self
                                        .send_stream_chunk(
                                            req_id,
                                            &stream_id,
                                            if finish_text.is_empty() {
                                                " "
                                            } else {
                                                &finish_text
                                            },
                                            true,
                                            ws_sink,
                                        )
                                        .await;
                                }

                                let questions = super::parse_question_event(&event);
                                let question_id = event
                                    .get("properties")
                                    .and_then(|p| p.get("id"))
                                    .and_then(|id| id.as_str())
                                    .unwrap_or("")
                                    .to_string();

                                // Send question as text with numbered options.
                                // User replies with /answer <number> or quote-reply.
                                {
                                    let text = super::format_question_message(
                                        &questions,
                                        &question_id,
                                        i18n::get_locale(&self.workspace_path),
                                    );
                                    let q_stream_id = uuid::Uuid::new_v4().to_string();
                                    let _ = self
                                        .send_stream_chunk(
                                            req_id,
                                            &q_stream_id,
                                            &text,
                                            true,
                                            ws_sink,
                                        )
                                        .await;
                                }

                                println!(
                                    "[WeCom] Question displayed as text: id={}, {} question(s)",
                                    question_id,
                                    questions.len()
                                );

                                // Prepare new stream for post-question response
                                stream_id = uuid::Uuid::new_v4().to_string();
                                accumulated_text.clear();
                                accumulated_reasoning.clear();
                                last_send_len = 0;

                                println!("[WeCom] Question displayed: {}", question_id);

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
                            // Thinking animation was stopped on question.asked (old stream_id),
                            // so no need to resume. Content will flow on the new stream_id.
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
                                // Track reasoning separately (used as fallback if no text output)
                                if part_type == "reasoning" {
                                    has_seen_activity = true;
                                    accumulated_reasoning.push_str(delta);
                                }

                                // Stream both text and reasoning to WeCom in real-time.
                                // Text takes priority; reasoning streams when no text yet.
                                let is_text = part_type == "text_delta" || part_type == "text";
                                let is_reasoning = part_type == "reasoning";

                                if is_text {
                                    has_seen_activity = true;
                                    // If we were streaming reasoning, switch to text-only
                                    if accumulated_text.is_empty()
                                        && !accumulated_reasoning.is_empty()
                                    {
                                        // Start fresh stream for text content
                                        stream_id = uuid::Uuid::new_v4().to_string();
                                        last_send_len = 0;
                                    }
                                    accumulated_text.push_str(delta);
                                }

                                // Determine what to stream: text if available, otherwise reasoning
                                let (stream_content, stream_len) = if !accumulated_text.is_empty() {
                                    (&accumulated_text, accumulated_text.len())
                                } else if is_reasoning {
                                    (&accumulated_reasoning, accumulated_reasoning.len())
                                } else {
                                    continue;
                                };

                                if is_text || is_reasoning {
                                    // On first content, stop thinking animation
                                    if thinking_active && last_send_len == 0 {
                                        thinking_active = false;
                                        let _ = thinking_ctl_tx.send(2);
                                        if let Err(e) = self
                                            .send_stream_chunk(
                                                req_id,
                                                &stream_id,
                                                stream_content,
                                                false,
                                                ws_sink,
                                            )
                                            .await
                                        {
                                            eprintln!("[WeCom] Failed to send first chunk: {}", e);
                                        }
                                        last_send_len = stream_len;
                                        last_send_time = tokio::time::Instant::now();
                                        continue;
                                    }

                                    // Send intermediate chunk every 2s or 500 chars
                                    let since_last = last_send_time.elapsed();
                                    let new_chars = stream_len - last_send_len;
                                    if since_last > std::time::Duration::from_secs(2)
                                        && new_chars > 10
                                        || new_chars > 500
                                    {
                                        if let Err(e) = self
                                            .send_stream_chunk(
                                                req_id,
                                                &stream_id,
                                                stream_content,
                                                false,
                                                ws_sink,
                                            )
                                            .await
                                        {
                                            eprintln!("[WeCom] Failed to send stream chunk: {}", e);
                                        }
                                        last_send_len = stream_len;
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

                                    // If no streaming text, use reasoning or fetch full message
                                    if accumulated_text.is_empty() {
                                        // First try reasoning content (some models only produce thinking)
                                        if !accumulated_reasoning.is_empty() {
                                            accumulated_text = accumulated_reasoning.clone();
                                        } else {
                                            // Last resort: fetch the full message from API
                                            let msg_id = info
                                                .get("id")
                                                .and_then(|id| id.as_str())
                                                .unwrap_or("");
                                            if let Ok(full_text) = super::fetch_message_content(
                                                port, session_id, msg_id,
                                            )
                                            .await
                                            {
                                                accumulated_text = full_text;
                                            }
                                        }
                                    }

                                    // Send final chunk — use text if available, otherwise reasoning
                                    let final_text = if !accumulated_text.is_empty() {
                                        accumulated_text
                                    } else if !accumulated_reasoning.is_empty() {
                                        accumulated_reasoning
                                    } else {
                                        "(No response)".to_string()
                                    };
                                    let _ = self
                                        .send_stream_chunk(
                                            req_id,
                                            &stream_id,
                                            &final_text,
                                            true,
                                            ws_sink,
                                        )
                                        .await;

                                    // After text stream, check for image parts and send them
                                    let msg_id_str =
                                        info.get("id").and_then(|id| id.as_str()).unwrap_or("");
                                    let gateway = self.clone();
                                    let req_id_owned = req_id.to_string();
                                    let ws_sink_clone = ws_sink.clone();
                                    let sid = session_id.to_string();
                                    let mid = msg_id_str.to_string();
                                    tokio::spawn(async move {
                                        gateway
                                            .send_image_parts_if_any(
                                                port,
                                                &sid,
                                                &mid,
                                                &req_id_owned,
                                                &ws_sink_clone,
                                            )
                                            .await;
                                    });

                                    return Ok(());
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

        let locale = i18n::get_locale(&self.workspace_path);
        let welcome = serde_json::json!({
            "cmd": "aibot_respond_welcome_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "text",
                "text": {
                    "content": i18n::t(i18n::MsgKey::WecomWelcome, locale)
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
        if let Some(entry) = self
            .pending_questions
            .take_by_question_id(question_id)
            .await
        {
            let _ = entry.answer_tx.send(option_value.to_string());
            println!(
                "[WeCom] Question {} answered via card: {}",
                question_id, option_value
            );
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
    /// Currently unused: WeCom doesn't render template_card after a stream
    /// response on the same req_id, and aibot_send_msg with template_card
    /// also fails to deliver. Kept for future investigation.
    #[allow(dead_code)]
    async fn send_question_card(
        &self,
        question_id: &str,
        question_text: &str,
        options: &[super::pending_question::QuestionOption],
        ws_sink: &WsSink,
        chatid: &str,
        chat_type: u32,
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
            "cmd": "aibot_send_msg",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": {
                "chatid": chatid,
                "chat_type": chat_type,
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

        println!(
            "[WeCom] Sending question card via aibot_send_msg: chatid={}, chat_type={}, task_id={}, payload={}",
            chatid, chat_type, task_id, card_msg
        );

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
            },
        );

        println!(
            "[WeCom] Question card sent successfully: task_id={}",
            task_id
        );
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
    pub async fn send_chat_message(
        &self,
        chatid: &str,
        chat_type: u32,
        text: &str,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let ws_sink = self.shared_ws_sink.read().await.clone().ok_or_else(|| {
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

        println!(
            "[WeCom] Proactive message sent to chatid={}, chat_type={}",
            chatid, chat_type
        );
        Ok(())
    }

    /// Simple non-streaming reply (for slash commands and errors)
    async fn send_reply(&self, req_id: &str, text: &str, ws_sink: &WsSink) -> Result<(), String> {
        let stream_id = uuid::Uuid::new_v4().to_string();
        self.send_stream_chunk(req_id, &stream_id, text, true, ws_sink)
            .await
    }

    /// Send a WS command and wait for the response (matched by req_id).
    async fn ws_request(
        &self,
        msg: serde_json::Value,
        req_id: &str,
        ws_sink: &WsSink,
    ) -> Result<serde_json::Value, String> {
        use futures_util::SinkExt;

        let (tx, rx) = oneshot::channel();
        self.pending_responses
            .lock()
            .await
            .insert(req_id.to_string(), tx);

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                msg.to_string().into(),
            ))
            .await
            .map_err(|e| {
                // Clean up on send failure
                let pending = self.pending_responses.clone();
                let rid = req_id.to_string();
                tokio::spawn(async move {
                    pending.lock().await.remove(&rid);
                });
                format!("Failed to send WS request: {}", e)
            })?;

        tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| "WS request timed out".to_string())?
            .map_err(|_| "WS response channel closed".to_string())
    }

    /// Upload media data to WeCom via the 3-step WebSocket upload protocol.
    /// `media_type` is one of: "image", "voice", "video", "file".
    /// Returns the media_id on success.
    async fn upload_media(
        &self,
        data: &[u8],
        filename: &str,
        media_type: &str,
        ws_sink: &WsSink,
    ) -> Result<String, String> {
        let md5_hash = format!("{:x}", md5::compute(data));
        let total_size = data.len();
        const CHUNK_SIZE: usize = 512 * 1024; // Max 512KB per chunk
        let total_chunks = (total_size + CHUNK_SIZE - 1) / CHUNK_SIZE;

        // Step 1: Init
        let init_req_id = uuid::Uuid::new_v4().to_string();
        let init_msg = serde_json::json!({
            "cmd": "aibot_upload_media_init",
            "headers": { "req_id": &init_req_id },
            "body": {
                "type": media_type,
                "filename": filename,
                "total_size": total_size,
                "total_chunks": total_chunks,
                "md5": &md5_hash,
            }
        });
        let init_resp = self.ws_request(init_msg, &init_req_id, ws_sink).await?;
        let upload_id = init_resp
            .get("body")
            .and_then(|b| b.get("upload_id"))
            .and_then(|u| u.as_str())
            .ok_or_else(|| {
                format!(
                    "No upload_id in init response: {}",
                    serde_json::to_string(&init_resp).unwrap_or_default()
                )
            })?
            .to_string();

        println!(
            "[WeCom] Media upload init: type={}, upload_id={}, chunks={}",
            media_type, upload_id, total_chunks
        );

        // Step 2: Upload chunks
        for i in 0..total_chunks {
            let start = i * CHUNK_SIZE;
            let end = (start + CHUNK_SIZE).min(total_size);
            let chunk_data = base64::engine::general_purpose::STANDARD.encode(&data[start..end]);

            let chunk_req_id = uuid::Uuid::new_v4().to_string();
            let chunk_msg = serde_json::json!({
                "cmd": "aibot_upload_media_chunk",
                "headers": { "req_id": &chunk_req_id },
                "body": {
                    "upload_id": &upload_id,
                    "chunk_index": i,
                    "base64_data": &chunk_data,
                }
            });
            let chunk_resp = self.ws_request(chunk_msg, &chunk_req_id, ws_sink).await?;
            let errcode = chunk_resp
                .get("body")
                .and_then(|b| b.get("errcode"))
                .and_then(|c| c.as_i64())
                .unwrap_or(0);
            if errcode != 0 {
                return Err(format!("Upload chunk {} failed: {:?}", i, chunk_resp));
            }
        }

        // Step 3: Finish
        let finish_req_id = uuid::Uuid::new_v4().to_string();
        let finish_msg = serde_json::json!({
            "cmd": "aibot_upload_media_finish",
            "headers": { "req_id": &finish_req_id },
            "body": {
                "upload_id": &upload_id,
            }
        });
        let finish_resp = self.ws_request(finish_msg, &finish_req_id, ws_sink).await?;
        let media_id = finish_resp
            .get("body")
            .and_then(|b| b.get("media_id"))
            .and_then(|m| m.as_str())
            .ok_or_else(|| {
                format!(
                    "No media_id in finish response: {}",
                    serde_json::to_string(&finish_resp).unwrap_or_default()
                )
            })?
            .to_string();

        println!(
            "[WeCom] Media upload complete: type={}, media_id={}",
            media_type,
            &media_id[..media_id.len().min(20)]
        );
        Ok(media_id)
    }

    /// Send a media message as a reply (image/voice/video/file).
    async fn send_media_reply(
        &self,
        req_id: &str,
        media_id: &str,
        media_type: &str,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let reply = serde_json::json!({
            "cmd": "aibot_respond_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": media_type,
                media_type: { "media_id": media_id },
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                reply.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send {} reply: {}", media_type, e))
    }

    /// Upload file bytes and send as a reply. Convenience wrapper.
    async fn upload_and_send_media_reply(
        &self,
        req_id: &str,
        data: &[u8],
        filename: &str,
        media_type: &str,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        let media_id = self
            .upload_media(data, filename, media_type, ws_sink)
            .await?;
        self.send_media_reply(req_id, &media_id, media_type, ws_sink)
            .await
    }

    /// Send a media message proactively to a chat (image/voice/video/file).
    pub async fn send_media_to_chat(
        &self,
        chatid: &str,
        chat_type: u32,
        media_id: &str,
        media_type: &str,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let ws_sink = self
            .shared_ws_sink
            .read()
            .await
            .clone()
            .ok_or_else(|| "WeCom gateway is not connected.".to_string())?;

        let msg = serde_json::json!({
            "cmd": "aibot_send_msg",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": {
                "chatid": chatid,
                "chat_type": chat_type,
                "msgtype": media_type,
                media_type: { "media_id": media_id },
            }
        });

        let text = msg.to_string();
        let mut guard = ws_sink.lock().await;
        guard
            .send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
            .await
            .map_err(|e| format!("Failed to send {}: {}", media_type, e))
    }

    /// After a message completes, fetch its parts and send any images to WeCom.
    async fn send_image_parts_if_any(
        &self,
        port: u16,
        session_id: &str,
        message_id: &str,
        req_id: &str,
        ws_sink: &WsSink,
    ) {
        // Fetch full message from OpenCode API
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let url = format!("http://127.0.0.1:{}/session/{}/message", port, session_id);
        let messages: Vec<serde_json::Value> = match client.get(&url).send().await {
            Ok(resp) => match resp.json().await {
                Ok(m) => m,
                Err(_) => return,
            },
            Err(_) => return,
        };

        // Find the target message
        let msg = match messages.iter().find(|m| {
            m.get("info")
                .and_then(|i| i.get("id"))
                .and_then(|id| id.as_str())
                == Some(message_id)
        }) {
            Some(m) => m,
            None => return,
        };

        let parts = match msg.get("parts").and_then(|p| p.as_array()) {
            Some(p) => p,
            None => return,
        };

        for part in parts {
            let part_type = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if part_type != "file" {
                continue;
            }

            // Extract data URL from the file part
            let content = match part.get("content").and_then(|c| c.as_str()) {
                Some(c) if c.starts_with("data:image/") => c,
                _ => continue,
            };

            // Parse data URL: data:image/png;base64,<data>
            let base64_part = match content.split(",").nth(1) {
                Some(b) => b,
                None => continue,
            };

            let image_bytes = match base64::engine::general_purpose::STANDARD.decode(base64_part) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("[WeCom] Failed to decode image base64: {}", e);
                    continue;
                }
            };

            // Determine filename from mime type
            let filename = if content.starts_with("data:image/png") {
                "image.png"
            } else if content.starts_with("data:image/gif") {
                "image.gif"
            } else if content.starts_with("data:image/webp") {
                "image.webp"
            } else {
                "image.jpg"
            };

            match self
                .upload_and_send_media_reply(req_id, &image_bytes, filename, "image", ws_sink)
                .await
            {
                Ok(()) => println!(
                    "[WeCom] Image part sent successfully ({} bytes)",
                    image_bytes.len()
                ),
                Err(e) => eprintln!("[WeCom] Failed to send image part: {}", e),
            }
        }
    }
}

/// Send a proactive message to a WeCom conversation.
/// Called by cron delivery and other modules that don't have direct gateway access.
/// Requires the WeCom gateway to be running and connected.
pub async fn send_proactive_message(
    chatid: &str,
    chat_type: u32,
    text: &str,
) -> Result<(), String> {
    let gateway = get_active_gateway_holder()
        .read()
        .await
        .clone()
        .ok_or_else(|| {
            "WeCom gateway is not running. Start the WeCom gateway before sending proactive messages.".to_string()
        })?;

    gateway.send_chat_message(chatid, chat_type, text).await
}

/// Upload media and send it to a WeCom conversation.
/// `media_type` is one of: "image", "voice", "video", "file".
/// Called by the introspect API for MCP media sending.
pub async fn upload_and_send_media(
    chatid: &str,
    chat_type: u32,
    data: &[u8],
    filename: &str,
    media_type: &str,
) -> Result<(), String> {
    let gateway = get_active_gateway_holder()
        .read()
        .await
        .clone()
        .ok_or_else(|| {
            "WeCom gateway is not running. Start the WeCom gateway before sending media."
                .to_string()
        })?;

    let ws_sink = gateway
        .shared_ws_sink
        .read()
        .await
        .clone()
        .ok_or_else(|| "WeCom gateway is not connected.".to_string())?;

    let media_id = gateway
        .upload_media(data, filename, media_type, &ws_sink)
        .await?;
    gateway
        .send_media_to_chat(chatid, chat_type, &media_id, media_type)
        .await
}
