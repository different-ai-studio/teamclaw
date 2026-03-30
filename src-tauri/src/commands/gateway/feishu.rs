use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::sync::Arc;
use tokio::sync::{oneshot, RwLock};

use super::feishu_config::{FeishuConfig, FeishuGatewayStatus, FeishuGatewayStatusResponse};
use super::i18n;
use super::session::SessionMapping;

use super::session_queue::{EnqueueResult, QueuedMessage, RejectReason, SessionQueue};
use super::{FilterResult, ProcessedMessageTracker, MAX_PROCESSED_MESSAGES};

/// Feishu API base URL
const FEISHU_API_BASE: &str = "https://open.feishu.cn";

// ==================== Protobuf Frame Codec ====================
// Feishu WS uses a custom protobuf binary frame protocol (pbbp2).
// We implement manual encode/decode to avoid heavy proto codegen.

/// Frame header key-value pair (proto field 1=key, 2=value)
#[derive(Debug, Clone, Default)]
struct PbHeader {
    key: String,
    value: String,
}

/// WebSocket binary frame (proto: pbbp2.Frame)
#[derive(Debug, Clone, Default)]
struct PbFrame {
    seq_id: u64,              // field 1, varint
    log_id: u64,              // field 2, varint
    service: i32,             // field 3, varint
    method: i32,              // field 4, varint (0=control, 1=data)
    headers: Vec<PbHeader>,   // field 5, repeated
    payload_encoding: String, // field 6
    payload_type: String,     // field 7
    payload: Vec<u8>,         // field 8
    log_id_new: String,       // field 9
}

impl PbFrame {
    /// Get a header value by key
    fn get_header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
    }

    /// Get header as int
    #[allow(dead_code)]
    fn get_header_int(&self, key: &str) -> i32 {
        self.get_header(key)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    }
}

// ---------- Protobuf encoding helpers ----------

fn encode_varint(buf: &mut Vec<u8>, mut val: u64) {
    loop {
        if val < 0x80 {
            buf.push(val as u8);
            return;
        }
        buf.push((val as u8 & 0x7F) | 0x80);
        val >>= 7;
    }
}

fn encode_tag(buf: &mut Vec<u8>, field: u32, wire_type: u32) {
    encode_varint(buf, ((field as u64) << 3) | wire_type as u64);
}

fn encode_varint_field(buf: &mut Vec<u8>, field: u32, val: u64) {
    encode_tag(buf, field, 0); // wire type 0 = varint
    encode_varint(buf, val);
}

fn encode_bytes_field(buf: &mut Vec<u8>, field: u32, data: &[u8]) {
    encode_tag(buf, field, 2); // wire type 2 = length-delimited
    encode_varint(buf, data.len() as u64);
    buf.extend_from_slice(data);
}

fn encode_string_field(buf: &mut Vec<u8>, field: u32, s: &str) {
    encode_bytes_field(buf, field, s.as_bytes());
}

impl PbHeader {
    fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_string_field(&mut buf, 1, &self.key);
        encode_string_field(&mut buf, 2, &self.value);
        buf
    }
}

impl PbFrame {
    fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_varint_field(&mut buf, 1, self.seq_id);
        encode_varint_field(&mut buf, 2, self.log_id);
        encode_varint_field(&mut buf, 3, self.service as u64);
        encode_varint_field(&mut buf, 4, self.method as u64);
        for h in &self.headers {
            let h_bytes = h.encode();
            encode_bytes_field(&mut buf, 5, &h_bytes);
        }
        if !self.payload_encoding.is_empty() {
            encode_string_field(&mut buf, 6, &self.payload_encoding);
        }
        if !self.payload_type.is_empty() {
            encode_string_field(&mut buf, 7, &self.payload_type);
        }
        if !self.payload.is_empty() {
            encode_bytes_field(&mut buf, 8, &self.payload);
        }
        if !self.log_id_new.is_empty() {
            encode_string_field(&mut buf, 9, &self.log_id_new);
        }
        buf
    }
}

// ---------- Protobuf decoding helpers ----------

fn decode_varint(data: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        if *pos >= data.len() {
            return Err("unexpected EOF in varint".to_string());
        }
        let b = data[*pos];
        *pos += 1;
        result |= ((b & 0x7F) as u64) << shift;
        if b < 0x80 {
            return Ok(result);
        }
        shift += 7;
        if shift >= 64 {
            return Err("varint too long".to_string());
        }
    }
}

fn decode_bytes<'a>(data: &'a [u8], pos: &mut usize) -> Result<&'a [u8], String> {
    let len = decode_varint(data, pos)? as usize;
    if *pos + len > data.len() {
        return Err("unexpected EOF in bytes field".to_string());
    }
    let result = &data[*pos..*pos + len];
    *pos += len;
    let _ = result.len();
    Ok(result)
}

fn decode_string(data: &[u8], pos: &mut usize) -> Result<String, String> {
    let bytes = decode_bytes(data, pos)?;
    String::from_utf8(bytes.to_vec()).map_err(|e| format!("invalid utf8: {}", e))
}

impl PbHeader {
    fn decode(data: &[u8]) -> Result<Self, String> {
        let mut pos = 0;
        let mut header = PbHeader::default();
        while pos < data.len() {
            let tag = decode_varint(data, &mut pos)?;
            let field = (tag >> 3) as u32;
            let wire = (tag & 0x7) as u32;
            match (field, wire) {
                (1, 2) => header.key = decode_string(data, &mut pos)?,
                (2, 2) => header.value = decode_string(data, &mut pos)?,
                (_, 0) => {
                    decode_varint(data, &mut pos)?;
                }
                (_, 2) => {
                    decode_bytes(data, &mut pos)?;
                }
                _ => return Err(format!("unexpected wire type {} for field {}", wire, field)),
            }
        }
        Ok(header)
    }
}

impl PbFrame {
    fn decode(data: &[u8]) -> Result<Self, String> {
        let mut pos = 0;
        let mut frame = PbFrame::default();
        while pos < data.len() {
            let tag = decode_varint(data, &mut pos)?;
            let field = (tag >> 3) as u32;
            let wire = (tag & 0x7) as u32;
            match (field, wire) {
                (1, 0) => frame.seq_id = decode_varint(data, &mut pos)?,
                (2, 0) => frame.log_id = decode_varint(data, &mut pos)?,
                (3, 0) => frame.service = decode_varint(data, &mut pos)? as i32,
                (4, 0) => frame.method = decode_varint(data, &mut pos)? as i32,
                (5, 2) => {
                    let h_bytes = decode_bytes(data, &mut pos)?;
                    frame.headers.push(PbHeader::decode(h_bytes)?);
                }
                (6, 2) => frame.payload_encoding = decode_string(data, &mut pos)?,
                (7, 2) => frame.payload_type = decode_string(data, &mut pos)?,
                (8, 2) => frame.payload = decode_bytes(data, &mut pos)?.to_vec(),
                (9, 2) => frame.log_id_new = decode_string(data, &mut pos)?,
                (_, 0) => {
                    decode_varint(data, &mut pos)?;
                }
                (_, 2) => {
                    decode_bytes(data, &mut pos)?;
                }
                (_, 1) => {
                    pos += 8;
                } // 64-bit
                (_, 5) => {
                    pos += 4;
                } // 32-bit
                _ => return Err(format!("unexpected wire type {} for field {}", wire, field)),
            }
        }
        Ok(frame)
    }
}

/// Create a Ping frame
fn new_ping_frame(service_id: i32) -> PbFrame {
    PbFrame {
        method: 0, // FrameTypeControl
        service: service_id,
        headers: vec![PbHeader {
            key: "type".to_string(),
            value: "ping".to_string(),
        }],
        ..Default::default()
    }
}

/// Create a response frame for an event
fn new_response_frame(original: &PbFrame, status_code: i32, biz_rt: &str) -> PbFrame {
    let mut headers: Vec<PbHeader> = original.headers.clone();
    headers.push(PbHeader {
        key: "biz_rt".to_string(),
        value: biz_rt.to_string(),
    });

    let resp_payload = serde_json::json!({
        "code": status_code,
        "headers": {},
        "data": null
    });

    PbFrame {
        seq_id: original.seq_id,
        log_id: original.log_id,
        service: original.service,
        method: original.method,
        headers,
        payload_encoding: original.payload_encoding.clone(),
        payload_type: original.payload_type.clone(),
        payload: resp_payload.to_string().into_bytes(),
        log_id_new: original.log_id_new.clone(),
    }
}

// ==================== Token Manager ====================

/// Token manager for Feishu app access token with auto-refresh
struct TokenManager {
    app_id: String,
    app_secret: String,
    token: Arc<RwLock<Option<String>>>,
    expires_at: Arc<RwLock<u64>>,
}

impl TokenManager {
    fn new(app_id: &str, app_secret: &str) -> Self {
        Self {
            app_id: app_id.to_string(),
            app_secret: app_secret.to_string(),
            token: Arc::new(RwLock::new(None)),
            expires_at: Arc::new(RwLock::new(0)),
        }
    }

    /// Get a valid access token, refreshing if necessary
    #[allow(dead_code)]
    async fn get_token(&self) -> Result<String, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let expires_at = *self.expires_at.read().await;
        if let Some(token) = self.token.read().await.as_ref() {
            if now + 300 < expires_at {
                return Ok(token.clone());
            }
        }
        self.refresh_token().await
    }

    /// Refresh the app access token (used for WebSocket auth)
    async fn refresh_token(&self) -> Result<String, String> {
        let client = reqwest::Client::new();
        let url = format!(
            "{}/open-apis/auth/v3/app_access_token/internal",
            FEISHU_API_BASE
        );

        println!("[Feishu] Refreshing app_access_token...");
        let response = client
            .post(&url)
            .header("Content-Type", "application/json; charset=utf-8")
            .json(&serde_json::json!({
                "app_id": self.app_id,
                "app_secret": self.app_secret
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to request token: {}", e))?;

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse token response: {}", e))?;

        let code = body["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            let msg = body["msg"].as_str().unwrap_or("Unknown error");
            return Err(format!("Feishu token error (code {}): {}", code, msg));
        }

        let token = body["app_access_token"]
            .as_str()
            .ok_or("No app_access_token in response")?
            .to_string();
        let expire = body["expire"].as_u64().unwrap_or(7200);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        *self.token.write().await = Some(token.clone());
        *self.expires_at.write().await = now + expire;

        println!("[Feishu] Token refreshed, expires in {} seconds", expire);
        Ok(token)
    }

    /// Also get a tenant_access_token for API calls (sending messages, etc.)
    async fn get_tenant_token(&self) -> Result<String, String> {
        let client = reqwest::Client::new();
        let url = format!(
            "{}/open-apis/auth/v3/tenant_access_token/internal",
            FEISHU_API_BASE
        );

        let response = client
            .post(&url)
            .header("Content-Type", "application/json; charset=utf-8")
            .json(&serde_json::json!({
                "app_id": self.app_id,
                "app_secret": self.app_secret
            }))
            .send()
            .await
            .map_err(|e| format!("Failed to request tenant token: {}", e))?;

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse tenant token response: {}", e))?;

        let code = body["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            let msg = body["msg"].as_str().unwrap_or("Unknown error");
            return Err(format!(
                "Feishu tenant token error (code {}): {}",
                code, msg
            ));
        }

        body["tenant_access_token"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "No tenant_access_token in response".to_string())
    }
}

// ==================== Feishu Gateway ====================

/// Feishu gateway manager
pub struct FeishuGateway {
    config: Arc<RwLock<FeishuConfig>>,
    session_mapping: SessionMapping,
    opencode_port: u16,
    workspace_path: String,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<FeishuGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    /// Permission auto-approver
    permission_approver: super::PermissionAutoApprover,
    session_queue: Arc<SessionQueue>,
    pending_questions: Arc<super::PendingQuestionStore>,
}

impl FeishuGateway {
    pub fn new(opencode_port: u16, session_mapping: SessionMapping, workspace_path: String) -> Self {
        Self {
            config: Arc::new(RwLock::new(FeishuConfig::default())),
            session_mapping,
            opencode_port,
            workspace_path,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(FeishuGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            permission_approver: super::PermissionAutoApprover::new(opencode_port),
            session_queue: Arc::new(SessionQueue::new()),
            pending_questions: Arc::new(super::PendingQuestionStore::new()),
        }
    }

    pub async fn set_config(&self, config: FeishuConfig) {
        *self.config.write().await = config;
    }

    pub async fn get_status(&self) -> FeishuGatewayStatusResponse {
        self.status.read().await.clone()
    }

    pub async fn start(&self) -> Result<(), String> {
        let config = self.config.read().await.clone();

        if !config.enabled {
            return Err("Feishu is not enabled".to_string());
        }
        if config.app_id.is_empty() || config.app_secret.is_empty() {
            return Err("Feishu app_id and app_secret are required".to_string());
        }

        {
            let mut is_running = self.is_running.write().await;
            if *is_running {
                return Err("Feishu gateway is already running".to_string());
            }
            *is_running = true;
        }

        {
            let mut status = self.status.write().await;
            status.status = FeishuGatewayStatus::Connecting;
            status.app_id = Some(config.app_id.clone());
        }

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        let config_arc = Arc::clone(&self.config);
        let status_arc = Arc::clone(&self.status);
        let is_running_arc = Arc::clone(&self.is_running);
        let session_mapping = self.session_mapping.clone();
        let opencode_port = self.opencode_port;
        let session_queue = Arc::clone(&self.session_queue);
        let pending_questions = Arc::clone(&self.pending_questions);
        let workspace_path = self.workspace_path.clone();

        tokio::spawn(async move {
            let result = run_feishu_gateway(
                config_arc,
                status_arc.clone(),
                session_mapping,
                opencode_port,
                shutdown_rx,
                session_queue,
                pending_questions,
                workspace_path,
            )
            .await;

            if let Err(e) = result {
                eprintln!("[Feishu] Gateway error: {}", e);
                let mut status = status_arc.write().await;
                *status = FeishuGatewayStatusResponse {
                    status: FeishuGatewayStatus::Error,
                    error_message: Some(e),
                    app_id: None,
                };
            }

            *is_running_arc.write().await = false;
            println!("[Feishu] Gateway stopped, is_running set to false");
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        if !*self.is_running.read().await {
            return Err("Feishu gateway is not running".to_string());
        }

        if let Some(tx) = self.shutdown_tx.write().await.take() {
            let _ = tx.send(());

            // Wait for the spawned task to finish (is_running becomes false)
            for _ in 0..50 {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                if !*self.is_running.read().await {
                    break;
                }
            }

            self.session_queue.shutdown().await;

            // Force reset state in case the wait timed out
            {
                let mut is_running = self.is_running.write().await;
                *is_running = false;
            }
            {
                let mut status = self.status.write().await;
                *status = FeishuGatewayStatusResponse::default();
            }
            self.session_mapping.clear_by_namespace("feishu").await;
            println!("[Feishu] Gateway fully stopped");
            Ok(())
        } else {
            *self.is_running.write().await = false;
            Err("Feishu gateway shutdown channel not found".to_string())
        }
    }

    pub async fn test_credentials(app_id: &str, app_secret: &str) -> Result<String, String> {
        let tm = TokenManager::new(app_id, app_secret);
        tm.refresh_token().await?;
        Ok("Credentials valid".to_string())
    }
}

impl Clone for FeishuGateway {
    fn clone(&self) -> Self {
        Self {
            config: Arc::clone(&self.config),
            session_mapping: self.session_mapping.clone(),
            opencode_port: self.opencode_port,
            workspace_path: self.workspace_path.clone(),
            shutdown_tx: Arc::clone(&self.shutdown_tx),
            status: Arc::clone(&self.status),
            is_running: Arc::clone(&self.is_running),
            permission_approver: self.permission_approver.clone(),
            session_queue: Arc::clone(&self.session_queue),
            pending_questions: Arc::clone(&self.pending_questions),
        }
    }
}

// ==================== Gateway Main Loop ====================

/// Get the WebSocket endpoint URL from Feishu API
/// Uses AppID + AppSecret in body (no bearer token), matching Go SDK behavior.
async fn get_ws_endpoint(app_id: &str, app_secret: &str) -> Result<(String, i32), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/callback/ws/endpoint", FEISHU_API_BASE);

    println!("[Feishu] Getting WS endpoint from: {}", url);
    let response = client
        .post(&url)
        .header("locale", "zh")
        .json(&serde_json::json!({
            "AppID": app_id,
            "AppSecret": app_secret
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to get WS endpoint: {}", e))?;

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse WS endpoint response: {}", e))?;

    let code = body["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = body["msg"].as_str().unwrap_or("Unknown error");
        return Err(format!("Feishu WS endpoint error (code {}): {}", code, msg));
    }

    let ws_url = body["data"]["URL"]
        .as_str()
        .ok_or("No URL in WS endpoint response")?
        .to_string();

    // Extract service_id from client config or URL
    let service_id = body["data"]["ClientConfig"]["ServiceID"]
        .as_i64()
        .unwrap_or(0) as i32;

    println!(
        "[Feishu] Got WS URL (service_id={}): {}...",
        service_id,
        &ws_url[..ws_url.len().min(80)]
    );
    Ok((ws_url, service_id))
}

async fn run_feishu_gateway(
    config: Arc<RwLock<FeishuConfig>>,
    status: Arc<RwLock<FeishuGatewayStatusResponse>>,
    session_mapping: SessionMapping,
    opencode_port: u16,
    mut shutdown_rx: oneshot::Receiver<()>,
    session_queue: Arc<SessionQueue>,
    pending_questions: Arc<super::PendingQuestionStore>,
    workspace_path: String,
) -> Result<(), String> {
    let cfg = config.read().await.clone();
    let token_manager = TokenManager::new(&cfg.app_id, &cfg.app_secret);

    // Validate credentials first
    token_manager.refresh_token().await?;

    let processed_messages: Arc<RwLock<ProcessedMessageTracker>> = Arc::new(RwLock::new(
        ProcessedMessageTracker::new(MAX_PROCESSED_MESSAGES),
    ));

    let mut retry_delay = std::time::Duration::from_secs(1);
    let max_retry_delay = std::time::Duration::from_secs(60);

    loop {
        // Get WebSocket endpoint (uses AppID/AppSecret directly, no bearer token)
        let (ws_url, service_id) = match get_ws_endpoint(&cfg.app_id, &cfg.app_secret).await {
            Ok(result) => {
                retry_delay = std::time::Duration::from_secs(1);
                result
            }
            Err(e) => {
                println!("[Feishu] Failed to get WS endpoint: {}", e);
                tokio::select! {
                    _ = &mut shutdown_rx => {
                        *status.write().await = FeishuGatewayStatusResponse::default();
                        return Ok(());
                    }
                    _ = tokio::time::sleep(retry_delay) => {}
                }
                retry_delay = (retry_delay * 2).min(max_retry_delay);
                continue;
            }
        };

        println!("[Feishu] Connecting to WebSocket...");
        let ws_result = tokio_tungstenite::connect_async(&ws_url).await;
        let ws_stream = match ws_result {
            Ok((stream, _)) => {
                println!("[Feishu] WebSocket connected");
                {
                    let mut s = status.write().await;
                    s.status = FeishuGatewayStatus::Connected;
                    s.error_message = None;
                    s.app_id = Some(cfg.app_id.clone());
                }
                retry_delay = std::time::Duration::from_secs(1);
                stream
            }
            Err(e) => {
                println!("[Feishu] WebSocket connection failed: {}", e);
                {
                    let mut s = status.write().await;
                    s.status = FeishuGatewayStatus::Connecting;
                    s.error_message = Some(format!("Connection failed: {}", e));
                }
                tokio::select! {
                    _ = &mut shutdown_rx => {
                        *status.write().await = FeishuGatewayStatusResponse::default();
                        return Ok(());
                    }
                    _ = tokio::time::sleep(retry_delay) => {}
                }
                retry_delay = (retry_delay * 2).min(max_retry_delay);
                continue;
            }
        };

        let ws_result = handle_ws_connection(
            ws_stream,
            &config,
            &session_mapping,
            opencode_port,
            &token_manager,
            &processed_messages,
            &mut shutdown_rx,
            service_id,
            &session_queue,
            &pending_questions,
            &workspace_path,
        )
        .await;

        match ws_result {
            Ok(WsExitReason::Shutdown) => {
                *status.write().await = FeishuGatewayStatusResponse::default();
                return Ok(());
            }
            Ok(WsExitReason::Disconnected) | Err(_) => {
                println!("[Feishu] Reconnecting...");
                {
                    let mut s = status.write().await;
                    s.status = FeishuGatewayStatus::Connecting;
                    s.error_message = Some("Reconnecting...".to_string());
                }
                tokio::select! {
                    _ = &mut shutdown_rx => {
                        *status.write().await = FeishuGatewayStatusResponse::default();
                        return Ok(());
                    }
                    _ = tokio::time::sleep(retry_delay) => {}
                }
                retry_delay = (retry_delay * 2).min(max_retry_delay);
            }
        }
    }
}

#[derive(Debug)]
enum WsExitReason {
    Shutdown,
    Disconnected,
}

// ==================== WebSocket Connection Handler ====================

async fn handle_ws_connection(
    ws_stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    config: &Arc<RwLock<FeishuConfig>>,
    session_mapping: &SessionMapping,
    opencode_port: u16,
    token_manager: &TokenManager,
    processed_messages: &Arc<RwLock<ProcessedMessageTracker>>,
    shutdown_rx: &mut oneshot::Receiver<()>,
    service_id: i32,
    session_queue: &Arc<SessionQueue>,
    pending_questions: &Arc<super::PendingQuestionStore>,
    workspace_path: &str,
) -> Result<WsExitReason, String> {
    use futures::sink::SinkExt;
    use futures::stream::StreamExt;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Spawn ping loop (send ping every 2 minutes, matching Go SDK)
    let ping_interval = std::time::Duration::from_secs(120);
    let (ping_shutdown_tx, mut ping_shutdown_rx) = oneshot::channel::<()>();
    let ws_sender_arc = Arc::new(tokio::sync::Mutex::new(None::<()>));
    let _ = ws_sender_arc; // we'll use a channel for sending instead

    // Use a channel to send messages from ping loop and handler
    let (send_tx, mut send_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    let send_tx_ping = send_tx.clone();

    // Ping loop task
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut ping_shutdown_rx => {
                    println!("[Feishu] Ping loop stopped");
                    return;
                }
                _ = tokio::time::sleep(ping_interval) => {
                    let ping_frame = new_ping_frame(service_id);
                    let data = ping_frame.encode();
                    if send_tx_ping.send(data).await.is_err() {
                        return;
                    }
                    println!("[Feishu] Ping sent");
                }
            }
        }
    });

    // Send loop - forwards binary messages to WS
    let (ws_done_tx, mut ws_done_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = send_rx.recv() => {
                    match msg {
                        Some(data) => {
                            if ws_sender.send(WsMessage::Binary(data.into())).await.is_err() {
                                return;
                            }
                        }
                        None => return,
                    }
                }
                _ = &mut ws_done_rx => {
                    let _ = ws_sender.close().await;
                    return;
                }
            }
        }
    });

    let result = loop {
        tokio::select! {
            _ = &mut *shutdown_rx => {
                println!("[Feishu] Shutdown signal received");
                break Ok(WsExitReason::Shutdown);
            }
            msg = ws_receiver.next() => {
                match msg {
                    Some(Ok(WsMessage::Binary(data))) => {
                        match PbFrame::decode(&data) {
                            Ok(frame) => {
                                handle_binary_frame(
                                    frame, config, session_mapping, opencode_port,
                                    token_manager, processed_messages, &send_tx,
                                    session_queue, pending_questions, &workspace_path,
                                ).await;
                            }
                            Err(e) => {
                                println!("[Feishu] Failed to decode frame: {}", e);
                            }
                        }
                    }
                    Some(Ok(WsMessage::Text(text))) => {
                        // Some Feishu implementations may send text frames
                        println!("[Feishu] Received text frame: {}", &text[..text.len().min(200)]);
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        let _ = send_tx.send(data.to_vec()).await; // send as pong
                    }
                    Some(Ok(WsMessage::Pong(_))) => {}
                    Some(Ok(WsMessage::Close(_))) => {
                        println!("[Feishu] WebSocket closed by server");
                        break Ok(WsExitReason::Disconnected);
                    }
                    Some(Ok(WsMessage::Frame(_))) => {}
                    Some(Err(e)) => {
                        println!("[Feishu] WebSocket error: {}", e);
                        break Err(format!("WebSocket error: {}", e));
                    }
                    None => {
                        println!("[Feishu] WebSocket stream ended");
                        break Ok(WsExitReason::Disconnected);
                    }
                }
            }
        }
    };

    // Cleanup
    let _ = ping_shutdown_tx.send(());
    let _ = ws_done_tx.send(());
    drop(send_tx);

    result
}

/// Handle a decoded protobuf binary frame
async fn handle_binary_frame(
    frame: PbFrame,
    config: &Arc<RwLock<FeishuConfig>>,
    session_mapping: &SessionMapping,
    opencode_port: u16,
    token_manager: &TokenManager,
    processed_messages: &Arc<RwLock<ProcessedMessageTracker>>,
    send_tx: &tokio::sync::mpsc::Sender<Vec<u8>>,
    session_queue: &Arc<SessionQueue>,
    pending_questions: &Arc<super::PendingQuestionStore>,
    workspace_path: &str,
) {
    let method = frame.method; // 0=control, 1=data
    let msg_type = frame.get_header("type").unwrap_or("").to_string();

    match method {
        0 => {
            // Control frame
            match msg_type.as_str() {
                "pong" => {
                    println!("[Feishu] Received pong");
                }
                _ => {
                    println!("[Feishu] Unknown control frame type: {}", msg_type);
                }
            }
        }
        1 => {
            // Data frame
            let message_id = frame.get_header("message_id").unwrap_or("").to_string();
            let trace_id = frame.get_header("trace_id").unwrap_or("").to_string();
            let start = std::time::Instant::now();

            println!(
                "[Feishu] Received data frame: type={}, message_id={}, trace_id={}",
                msg_type, message_id, trace_id
            );

            match msg_type.as_str() {
                "event" => {
                    // Payload is JSON event data
                    let payload_str = String::from_utf8_lossy(&frame.payload);
                    println!(
                        "[Feishu] Event payload: {}",
                        &payload_str[..payload_str.len().min(300)]
                    );

                    // Parse the event JSON
                    if let Ok(event_json) =
                        serde_json::from_slice::<serde_json::Value>(&frame.payload)
                    {
                        // Check for duplicate
                        let event_id = event_json["header"]["event_id"]
                            .as_str()
                            .unwrap_or(&message_id)
                            .to_string();

                        let is_dup = {
                            let mut tracker = processed_messages.write().await;
                            tracker.is_duplicate(&event_id)
                        };

                        // Send response frame back IMMEDIATELY to acknowledge the event
                        // (Feishu requires quick acknowledgment, or it will retry)
                        let elapsed = start.elapsed().as_millis().to_string();
                        let resp = new_response_frame(&frame, 200, &elapsed);
                        let _ = send_tx.send(resp.encode()).await;

                        if is_dup {
                            println!("[Feishu] Duplicate event {}, skipping", event_id);
                        } else {
                            let event_type = event_json["header"]["event_type"]
                                .as_str()
                                .unwrap_or("")
                                .to_string();

                            if event_type == "im.message.receive_v1" {
                                // Spawn message handling as a separate task so we don't block the WS loop
                                let event_data = event_json["event"].clone();
                                let config_clone = Arc::clone(config);
                                let session_mapping_clone = session_mapping.clone();
                                let token_manager_app_id = token_manager.app_id.clone();
                                let token_manager_app_secret = token_manager.app_secret.clone();
                                let session_queue_clone = Arc::clone(session_queue);
                                let pending_questions_clone = Arc::clone(pending_questions);
                                let workspace_path_clone = workspace_path.to_string();
                                tokio::spawn(async move {
                                    println!("[Feishu] Spawned message handler task");
                                    let tm = TokenManager::new(
                                        &token_manager_app_id,
                                        &token_manager_app_secret,
                                    );
                                    handle_message_event(
                                        &event_data,
                                        &config_clone,
                                        &session_mapping_clone,
                                        opencode_port,
                                        &tm,
                                        &session_queue_clone,
                                        &pending_questions_clone,
                                        &workspace_path_clone,
                                    )
                                    .await;
                                    println!("[Feishu] Message handler task completed");
                                });
                            } else {
                                println!("[Feishu] Unhandled event type: {}", event_type);
                            }
                        }
                    } else {
                        // Failed to parse event JSON, still send ack
                        let elapsed = start.elapsed().as_millis().to_string();
                        let resp = new_response_frame(&frame, 200, &elapsed);
                        let _ = send_tx.send(resp.encode()).await;
                    }
                }
                _ => {
                    println!("[Feishu] Unknown data frame type: {}", msg_type);
                }
            }
        }
        _ => {
            println!("[Feishu] Unknown frame method: {}", method);
        }
    }
}

// ==================== Message Event Handler ====================

/// Handle an im.message.receive_v1 event
async fn handle_message_event(
    event: &serde_json::Value,
    config: &Arc<RwLock<FeishuConfig>>,
    session_mapping: &SessionMapping,
    opencode_port: u16,
    token_manager: &TokenManager,
    session_queue: &Arc<SessionQueue>,
    pending_questions: &Arc<super::PendingQuestionStore>,
    workspace_path: &str,
) {
    let sender = &event["sender"];
    let sender_id = sender["sender_id"]["open_id"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let sender_type = sender["sender_type"].as_str().unwrap_or("");

    if sender_type == "app" {
        println!("[Feishu] Ignoring bot message");
        return;
    }

    let message = &event["message"];
    let message_id = message["message_id"].as_str().unwrap_or("").to_string();
    let chat_id = message["chat_id"].as_str().unwrap_or("").to_string();
    let chat_type = message["chat_type"].as_str().unwrap_or("");
    let msg_type = message["message_type"].as_str().unwrap_or("");

    println!(
        "[Feishu] Message: sender={}, chat_id={}, chat_type={}, msg_type={}",
        sender_id, chat_id, chat_type, msg_type
    );

    // Extract text content
    let content_str = message["content"].as_str().unwrap_or("{}");
    let content_json: serde_json::Value = serde_json::from_str(content_str).unwrap_or_default();

    let text_content = match msg_type {
        "text" => content_json["text"].as_str().unwrap_or("").to_string(),
        "image" => "[image]".to_string(),
        "post" => extract_post_text(&content_json),
        _ => {
            println!("[Feishu] Unsupported message type: {}", msg_type);
            return;
        }
    };

    // Clean @mentions
    let clean_text = clean_at_mentions(&text_content);

    if clean_text.is_empty() && msg_type != "image" {
        return;
    }

    // Check if this is a reply to a pending question (Feishu parent_id)
    let parent_id = message["parent_id"].as_str();
    if let Some(pid) = parent_id {
        if !pid.is_empty() {
            if let Some(entry) = pending_questions.take(pid).await {
                let _ = entry.answer_tx.send(clean_text.clone());
                println!(
                    "[Feishu] Question {} answered via reply to {}",
                    entry.question_id, pid
                );
                return;
            }
        }
    }

    // Check config filter
    let cfg = config.read().await.clone();
    let filter = check_feishu_allowed(&cfg, &chat_id, &sender_id);

    match filter {
        FilterResult::Allow => {}
        FilterResult::Ignore => return,
        FilterResult::UserNotAllowed => {
            if let Ok(token) = token_manager.get_tenant_token().await {
                let _ = reply_feishu_message(&token, &message_id,
                    "Sorry, you are not authorized to use this bot. Please contact the administrator to request access.").await;
            }
            return;
        }
        FilterResult::ChannelNotConfigured => {
            if let Ok(token) = token_manager.get_tenant_token().await {
                let _ = reply_feishu_message(&token, &message_id,
                    "This chat is not configured for the bot. Please ask the administrator to add this chat in TeamClaw settings.").await;
            }
            return;
        }
    }

    // Build session key for this chat context (used for session ID, model preference, and commands)
    let session_key = format!("feishu:{}", chat_id);
    let locale = i18n::get_locale(workspace_path);

    // Check for /answer command — routes reply to the most recent pending question
    if let Some(answer_text) = super::PendingQuestionStore::parse_answer_command(&clean_text) {
        if let Some(qid) = pending_questions.try_answer(answer_text).await {
            println!(
                "[Feishu] Question {} answered via /answer: {}",
                qid, answer_text
            );
            if let Ok(token) = token_manager.get_tenant_token().await {
                let _ = reply_feishu_message(
                    &token,
                    &message_id,
                    &i18n::t(i18n::MsgKey::AnswerSubmitted(answer_text), locale),
                )
                .await;
            }
        } else if let Ok(token) = token_manager.get_tenant_token().await {
            let _ = reply_feishu_message(&token, &message_id, &i18n::t(i18n::MsgKey::NoPendingQuestions, locale)).await;
        }
        return;
    }

    // Handle /model command
    if clean_text.eq_ignore_ascii_case("/model") || clean_text.to_lowercase().starts_with("/model ")
    {
        let arg = if clean_text.len() > 7 {
            clean_text[7..].trim()
        } else {
            ""
        };
        println!("[Feishu] Model command received, arg: '{}'", arg);
        let response =
            super::handle_model_command(opencode_port, session_mapping, &session_key, arg, locale).await;

        if let Ok(token) = token_manager.get_tenant_token().await {
            let chunks = split_message(&response, 4000);
            let mut first = true;
            for chunk in chunks {
                if first {
                    first = false;
                    let _ = reply_feishu_message(&token, &message_id, &chunk).await;
                } else {
                    let _ = send_feishu_message(&token, &chat_id, &chunk).await;
                }
            }
        }
        return;
    }

    // Handle /reset command
    if clean_text.eq_ignore_ascii_case("/reset") {
        session_mapping.remove_session(&session_key).await;
        if let Ok(token) = token_manager.get_tenant_token().await {
            let _ = reply_feishu_message(
                &token,
                &message_id,
                &i18n::t(i18n::MsgKey::SessionReset, locale),
            )
            .await;
        }
        return;
    }

    // Handle /stop command
    if clean_text.eq_ignore_ascii_case("/stop") {
        println!("[Feishu] Stop command received");
        let response =
            super::handle_stop_command(opencode_port, session_mapping, &session_key, locale).await;
        if let Ok(token) = token_manager.get_tenant_token().await {
            let _ = reply_feishu_message(&token, &message_id, &response).await;
        }
        return;
    }

    // Handle /sessions command
    if clean_text.eq_ignore_ascii_case("/sessions")
        || clean_text.to_lowercase().starts_with("/sessions ")
    {
        let arg = if clean_text.len() > 10 {
            clean_text[10..].trim()
        } else {
            ""
        };
        println!("[Feishu] Sessions command received, arg: '{}'", arg);
        let response =
            super::handle_sessions_command(opencode_port, session_mapping, &session_key, arg, locale).await;

        if let Ok(token) = token_manager.get_tenant_token().await {
            let chunks = split_message(&response, 4000);
            let mut first = true;
            for chunk in chunks {
                if first {
                    first = false;
                    let _ = reply_feishu_message(&token, &message_id, &chunk).await;
                } else {
                    let _ = send_feishu_message(&token, &chat_id, &chunk).await;
                }
            }
        }
        return;
    }

    // Handle image messages (outside queue - network I/O that doesn't need serialization)
    let mut images: Vec<(String, String)> = Vec::new();
    if msg_type == "image" {
        let image_key = content_json["image_key"].as_str().unwrap_or("");
        if !image_key.is_empty() {
            if let Ok(token) = token_manager.get_tenant_token().await {
                match download_feishu_image(&token, &message_id, image_key).await {
                    Ok((data_uri, mime)) => images.push((data_uri, mime)),
                    Err(e) => println!("[Feishu] Failed to download image: {}", e),
                }
            }
        }
    }

    let content_to_send = if clean_text == "[image]" && !images.is_empty() {
        "Please analyze this image.".to_string()
    } else {
        clean_text.clone()
    };

    // Look up model preference for this context (outside queue - read-only lookup)
    let model_param = session_mapping
        .get_model(&session_key)
        .await
        .and_then(|m| super::parse_model_preference(&m));

    // Process through per-session queue
    let session_mapping_owned = session_mapping.clone();
    let session_key_owned = session_key.clone();
    let content_owned = content_to_send.clone();
    let images_owned = images.clone();
    let model_param_owned = model_param.clone();
    let message_id_owned = message_id.clone();
    let chat_id_owned = chat_id.clone();
    let sender_id_owned = sender_id.clone();
    let tm_app_id = token_manager.app_id.clone();
    let tm_app_secret = token_manager.app_secret.clone();

    // Clone for notify_fn
    let message_id2 = message_id.clone();
    let tm_app_id2 = token_manager.app_id.clone();
    let tm_app_secret2 = token_manager.app_secret.clone();

    let pending_questions_for_closure = Arc::clone(pending_questions);

    let result = session_queue
        .enqueue(
            &session_key,
            QueuedMessage {
                enqueued_at: std::time::Instant::now(),
                process_fn: Box::new(move || {
                    Box::pin(async move {
                        let tm = TokenManager::new(&tm_app_id, &tm_app_secret);

                        // Get or create session
                        let session_id =
                            match session_mapping_owned.get_session(&session_key_owned).await {
                                Some(id) => id,
                                None => match create_opencode_session(opencode_port).await {
                                    Ok(id) => {
                                        session_mapping_owned
                                            .set_session(session_key_owned.clone(), id.clone())
                                            .await;
                                        id
                                    }
                                    Err(e) => {
                                        if let Ok(token) = tm.get_tenant_token().await {
                                            let _ = reply_feishu_message(
                                                &token,
                                                &message_id_owned,
                                                &format!("Error: {}", e),
                                            )
                                            .await;
                                        }
                                        return;
                                    }
                                },
                            };

                        // Send "Thinking..." card
                        let processing_msg_id = if let Ok(token) = tm.get_tenant_token().await {
                            reply_feishu_card_message(
                                &token,
                                &message_id_owned,
                                "🤔 Thinking...",
                                None,
                            )
                            .await
                            .ok()
                        } else {
                            None
                        };

                        // Build question context for forwarding AI questions to Feishu
                        let pending_questions_clone = Arc::clone(&pending_questions_for_closure);
                        let tm_app_id_for_q = tm.app_id.clone();
                        let tm_app_secret_for_q = tm.app_secret.clone();
                        let message_id_for_q = message_id_owned.clone();
                        let locale_for_q = locale;
                        let question_ctx = super::QuestionContext {
                            forwarder: Box::new(move |fq: super::ForwardedQuestion| {
                                let app_id = tm_app_id_for_q.clone();
                                let app_secret = tm_app_secret_for_q.clone();
                                let mid = message_id_for_q.clone();
                                Box::pin(async move {
                                    let tm = TokenManager::new(&app_id, &app_secret);
                                    let token = tm
                                        .get_tenant_token()
                                        .await
                                        .map_err(|e| format!("Failed to get token: {}", e))?;
                                    let text = super::format_question_message(
                                        &fq.questions,
                                        &fq.question_id,
                                        locale_for_q,
                                    );
                                    reply_feishu_message(&token, &mid, &text).await
                                })
                            }),
                            store: pending_questions_clone,
                        };

                        // Build sender identity for message prefix
                        let channel_sender = super::ChannelSender {
                            platform: "feishu".to_string(),
                            external_id: sender_id_owned.clone(),
                            display_name: sender_id_owned.clone(), // open_id as fallback
                        };

                        // Send to OpenCode
                        let result = send_to_opencode(
                            opencode_port,
                            &session_id,
                            &content_owned,
                            images_owned,
                            model_param_owned,
                            Some(question_ctx),
                            Some(&channel_sender),
                        )
                        .await;

                        // Reply (edit Thinking card or send new message)
                        if let Ok(token) = tm.get_tenant_token().await {
                            match result {
                                Ok(response) => {
                                    let chunks = split_message(&response, 4000);
                                    if let Some(ref proc_id) = processing_msg_id {
                                        if !proc_id.is_empty() {
                                            match update_feishu_message(&token, proc_id, &chunks[0])
                                                .await
                                            {
                                                Ok(_) => {}
                                                Err(_) => {
                                                    let _ = reply_feishu_message(
                                                        &token,
                                                        &message_id_owned,
                                                        &chunks[0],
                                                    )
                                                    .await;
                                                }
                                            }
                                            for chunk in chunks.iter().skip(1) {
                                                let _ = send_feishu_message(
                                                    &token,
                                                    &chat_id_owned,
                                                    chunk,
                                                )
                                                .await;
                                            }
                                        } else {
                                            let mut first = true;
                                            for chunk in chunks {
                                                if first {
                                                    first = false;
                                                    let _ = reply_feishu_message(
                                                        &token,
                                                        &message_id_owned,
                                                        &chunk,
                                                    )
                                                    .await;
                                                } else {
                                                    let _ = send_feishu_message(
                                                        &token,
                                                        &chat_id_owned,
                                                        &chunk,
                                                    )
                                                    .await;
                                                }
                                            }
                                        }
                                    } else {
                                        let mut first = true;
                                        for chunk in chunks {
                                            if first {
                                                first = false;
                                                let _ = reply_feishu_message(
                                                    &token,
                                                    &message_id_owned,
                                                    &chunk,
                                                )
                                                .await;
                                            } else {
                                                let _ = send_feishu_message(
                                                    &token,
                                                    &chat_id_owned,
                                                    &chunk,
                                                )
                                                .await;
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    if let Some(ref proc_id) = processing_msg_id {
                                        if !proc_id.is_empty() {
                                            let _ = update_feishu_message(
                                                &token,
                                                proc_id,
                                                &format!("❌ Error: {}", e),
                                            )
                                            .await;
                                        } else {
                                            let _ = reply_feishu_message(
                                                &token,
                                                &message_id_owned,
                                                &format!("Error: {}", e),
                                            )
                                            .await;
                                        }
                                    } else {
                                        let _ = reply_feishu_message(
                                            &token,
                                            &message_id_owned,
                                            &format!("Error: {}", e),
                                        )
                                        .await;
                                    }
                                }
                            }
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
                        let tm = TokenManager::new(&tm_app_id2, &tm_app_secret2);
                        if let Ok(token) = tm.get_tenant_token().await {
                            let _ = reply_feishu_message(&token, &message_id2, msg).await;
                        }
                    })
                })),
            },
        )
        .await;

    match result {
        EnqueueResult::Queued { position } if position > 0 => {
            if let Ok(token) = token_manager.get_tenant_token().await {
                let _ = reply_feishu_message(
                    &token,
                    &message_id,
                    &format!("Message queued (position: {}). Please wait...", position),
                )
                .await;
            }
        }
        EnqueueResult::Full => { /* notify_fn already handled */ }
        _ => { /* Processing or Queued{0} — no feedback needed */ }
    }
}

// ==================== Helpers ====================

fn check_feishu_allowed(config: &FeishuConfig, chat_id: &str, sender_id: &str) -> FilterResult {
    let chat_config = config.chats.get(chat_id).or_else(|| config.chats.get("*"));

    let chat_config = match chat_config {
        Some(c) => c,
        None => {
            if config.chats.is_empty() {
                return FilterResult::Allow;
            }
            return FilterResult::ChannelNotConfigured;
        }
    };

    if !chat_config.allow {
        return FilterResult::ChannelNotConfigured;
    }

    if !chat_config.users.is_empty()
        && !chat_config.users.contains(&sender_id.to_string())
        && !chat_config.users.contains(&"*".to_string())
    {
        return FilterResult::UserNotAllowed;
    }

    FilterResult::Allow
}

fn clean_at_mentions(text: &str) -> String {
    let mut result = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '@' {
            if chars.peek() == Some(&'_') {
                // Skip @_user_N or @_all mentions
                while let Some(&next) = chars.peek() {
                    if next == ' ' || next == '\n' {
                        break;
                    }
                    chars.next();
                }
            } else {
                result.push(c);
            }
        } else {
            result.push(c);
        }
    }
    result.trim().to_string()
}

fn extract_post_text(content: &serde_json::Value) -> String {
    let mut texts = Vec::new();
    if let Some(title) = content["title"].as_str() {
        if !title.is_empty() {
            texts.push(format!("{}\n", title));
        }
    }
    if let Some(content_arr) = content["content"].as_array() {
        for line in content_arr {
            if let Some(elements) = line.as_array() {
                for elem in elements {
                    match elem["tag"].as_str().unwrap_or("") {
                        "text" | "a" => {
                            if let Some(t) = elem["text"].as_str() {
                                texts.push(t.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            texts.push("\n".to_string());
        }
    }
    texts.join("").trim().to_string()
}

async fn create_opencode_session(port: u16) -> Result<String, String> {
    super::create_opencode_session(port).await
}

async fn send_to_opencode(
    port: u16,
    session_id: &str,
    content: &str,
    images: Vec<(String, String)>,
    model: Option<(String, String)>,
    question_ctx: Option<super::QuestionContext>,
    sender: Option<&super::ChannelSender>,
) -> Result<String, String> {
    println!(
        "[Feishu] Sending to OpenCode: content: {}, images: {}",
        content,
        images.len()
    );

    let mut parts = Vec::new();
    if !content.is_empty() {
        parts.push(serde_json::json!({"type": "text", "text": content}));
    }
    for (data_uri, mime_type) in &images {
        parts.push(serde_json::json!({"type": "file", "url": data_uri, "mime": mime_type}));
    }
    if parts.is_empty() {
        parts.push(serde_json::json!({"type": "text", "text": ""}));
    }

    println!("[Feishu] Sending message asynchronously with permission auto-approval");

    // Use async send with permission auto-approval
    super::send_message_async_with_approval(port, session_id, parts, model, question_ctx, sender)
        .await
}

/// Reply to a Feishu message. Returns the reply message_id on success.
async fn reply_feishu_message(token: &str, message_id: &str, text: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/open-apis/im/v1/messages/{}/reply",
        FEISHU_API_BASE, message_id
    );
    let body = serde_json::json!({
        "content": serde_json::json!({"text": text}).to_string(),
        "msg_type": "text"
    });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to reply: {}", e))?;

    let resp: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = resp["msg"].as_str().unwrap_or("Unknown");
        return Err(format!("Reply error (code {}): {}", code, msg));
    }
    let reply_msg_id = resp["data"]["message_id"]
        .as_str()
        .unwrap_or("")
        .to_string();
    println!(
        "[Feishu] Reply sent to {} (reply_id={})",
        message_id, reply_msg_id
    );
    Ok(reply_msg_id)
}

/// Update (edit) an existing Feishu card message content.
/// The message MUST have been sent as an interactive card; plain text messages cannot be updated.
async fn update_feishu_message(token: &str, message_id: &str, text: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/open-apis/im/v1/messages/{}",
        FEISHU_API_BASE, message_id
    );

    // Build a card with the text content (matching the card format used when sending)
    let card = build_simple_card(text, None);
    let body = serde_json::json!({
        "content": card.to_string(),
        "msg_type": "interactive"
    });

    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to update message: {}", e))?;

    let resp: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = resp["msg"].as_str().unwrap_or("Unknown");
        return Err(format!("Update error (code {}): {}", code, msg));
    }
    println!("[Feishu] Message {} updated", message_id);
    Ok(())
}

/// Build a simple Feishu interactive card JSON with text content.
/// Optionally set a card title.
fn build_simple_card(text: &str, title: Option<&str>) -> serde_json::Value {
    let elements = vec![serde_json::json!({
        "tag": "markdown",
        "content": text
    })];

    let mut card = serde_json::json!({
        "elements": elements
    });

    if let Some(t) = title {
        card["header"] = serde_json::json!({
            "title": {
                "tag": "plain_text",
                "content": t
            }
        });
    }

    card
}

/// Reply to a Feishu message with an interactive card (supports subsequent updates).
async fn reply_feishu_card_message(
    token: &str,
    message_id: &str,
    text: &str,
    title: Option<&str>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/open-apis/im/v1/messages/{}/reply",
        FEISHU_API_BASE, message_id
    );

    let card = build_simple_card(text, title);
    let body = serde_json::json!({
        "content": card.to_string(),
        "msg_type": "interactive"
    });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to reply card: {}", e))?;

    let resp: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = resp["msg"].as_str().unwrap_or("Unknown");
        return Err(format!("Card reply error (code {}): {}", code, msg));
    }
    let reply_msg_id = resp["data"]["message_id"]
        .as_str()
        .unwrap_or("")
        .to_string();
    println!(
        "[Feishu] Card reply sent to {} (reply_id={})",
        message_id, reply_msg_id
    );
    Ok(reply_msg_id)
}

/// Send a text message to a Feishu chat using app credentials.
/// Standalone utility — obtains a tenant token internally and sends the message.
/// Used by both the gateway and cron delivery.
pub async fn send_chat_message(
    app_id: &str,
    app_secret: &str,
    chat_id: &str,
    text: &str,
) -> Result<(), String> {
    let tm = TokenManager::new(app_id, app_secret);
    let token = tm.get_tenant_token().await?;
    send_feishu_message(&token, chat_id, text).await
}

async fn send_feishu_message(token: &str, chat_id: &str, text: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/open-apis/im/v1/messages?receive_id_type=chat_id",
        FEISHU_API_BASE
    );
    let body = serde_json::json!({
        "receive_id": chat_id,
        "content": serde_json::json!({"text": text}).to_string(),
        "msg_type": "text"
    });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to send: {}", e))?;

    let resp: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    let code = resp["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = resp["msg"].as_str().unwrap_or("Unknown");
        return Err(format!("Send error (code {}): {}", code, msg));
    }
    Ok(())
}

async fn download_feishu_image(
    token: &str,
    message_id: &str,
    image_key: &str,
) -> Result<(String, String), String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/open-apis/im/v1/messages/{}/resources/{}?type=image",
        FEISHU_API_BASE, message_id, image_key
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Failed to download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read: {}", e))?;
    let b64 = BASE64.encode(&bytes);
    Ok((
        format!("data:{};base64,{}", content_type, b64),
        content_type,
    ))
}

fn split_message(content: &str, max_len: usize) -> Vec<String> {
    if content.len() <= max_len {
        return vec![content.to_string()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in content.lines() {
        if current.len() + line.len() + 1 > max_len {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            if line.len() > max_len {
                let mut remaining = line;
                while remaining.len() > max_len {
                    let at = remaining
                        .char_indices()
                        .take_while(|(i, _)| *i < max_len)
                        .last()
                        .map(|(i, c)| i + c.len_utf8())
                        .unwrap_or(max_len);
                    let (chunk, rest) = remaining.split_at(at);
                    chunks.push(chunk.to_string());
                    remaining = rest;
                }
                current = remaining.to_string();
            } else {
                current = line.to_string();
            }
        } else {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(line);
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}
