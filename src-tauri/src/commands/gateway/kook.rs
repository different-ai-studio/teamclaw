use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::{RwLock, oneshot, mpsc};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;

use super::kook_config::{KookConfig, KookGatewayStatus, KookGatewayStatusResponse};
use super::session::SessionMapping;

use super::{FilterResult, ProcessedMessageTracker, MAX_PROCESSED_MESSAGES};

/// Maximum number of buffered out-of-order messages
const MAX_BUFFER_SIZE: usize = 100;

/// KOOK API base URL
pub const KOOK_API_BASE: &str = "https://www.kookapp.cn/api/v3";

/// Heartbeat interval (30s ± 5s random)
const HEARTBEAT_INTERVAL_SECS: u64 = 30;

/// Heartbeat timeout (6s)
const HEARTBEAT_TIMEOUT_SECS: u64 = 6;

/// WebSocket connection exit reason
#[derive(Debug)]
enum WsExitReason {
    Shutdown,
    Disconnected,
}


/// KOOK WebSocket signal types
#[derive(Debug)]
enum Signal {
    Event = 0,
    Hello = 1,
    Ping = 2,
    Pong = 3,
    #[allow(dead_code)]
    Resume = 4,
    Reconnect = 5,
    ResumeAck = 6,
}

/// KOOK event structure
#[derive(Debug, Clone, Deserialize)]
struct KookEvent {
    #[serde(rename = "s")]
    signal: u8,
    #[serde(rename = "d", default)]
    data: serde_json::Value,
    #[serde(rename = "sn")]
    sn: Option<u64>,
}

/// KOOK message event data
#[derive(Debug, Clone, Deserialize)]
struct KookMessageData {
    channel_type: String,
    #[serde(rename = "type")]
    msg_type: u8,
    target_id: String,
    author_id: String,
    content: String,
    msg_id: String,
    msg_timestamp: u64,
    extra: serde_json::Value,
}

impl KookMessageData {
    fn to_json(&self) -> serde_json::Value {
        json!({
            "channel_type": self.channel_type,
            "type": self.msg_type,
            "target_id": self.target_id,
            "author_id": self.author_id,
            "content": self.content,
            "msg_id": self.msg_id,
            "msg_timestamp": self.msg_timestamp,
            "extra": self.extra,
        })
    }
}

/// KOOK gateway implementation
pub struct KookGateway {
    config: Arc<RwLock<KookConfig>>,
    session_mapping: SessionMapping,
    opencode_port: u16,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<KookGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    /// WebSocket session ID from HELLO
    ws_session_id: Arc<RwLock<Option<String>>>,
    /// Last processed sequence number
    last_sn: Arc<AtomicU64>,
    /// Tracker for processed message IDs to prevent duplicates
    processed_messages: Arc<RwLock<ProcessedMessageTracker>>,
    /// Bot's own user ID (fetched via /user/me on startup)
    bot_user_id: Arc<RwLock<Option<String>>>,
    /// Permission auto-approver
    permission_approver: super::PermissionAutoApprover,
    /// Pending questions awaiting replies
    pending_questions: Arc<super::PendingQuestionStore>,
}

impl KookGateway {
    pub fn new(opencode_port: u16, session_mapping: SessionMapping) -> Self {
        Self {
            config: Arc::new(RwLock::new(KookConfig::default())),
            session_mapping,
            opencode_port,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(KookGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            ws_session_id: Arc::new(RwLock::new(None)),
            last_sn: Arc::new(AtomicU64::new(0)),
            processed_messages: Arc::new(RwLock::new(ProcessedMessageTracker::new(MAX_PROCESSED_MESSAGES))),
            bot_user_id: Arc::new(RwLock::new(None)),
            permission_approver: super::PermissionAutoApprover::new(opencode_port),
            pending_questions: Arc::new(super::PendingQuestionStore::new()),
        }
    }

    pub async fn set_config(&self, config: KookConfig) {
        let mut cfg = self.config.write().await;
        *cfg = config;
    }

    pub async fn get_status(&self) -> KookGatewayStatusResponse {
        self.status.read().await.clone()
    }

    pub async fn start(&self) -> Result<(), String> {
        {
            let running = self.is_running.read().await;
            if *running {
                return Err("KOOK gateway is already running".to_string());
            }
        }

        let config = self.config.read().await.clone();

        if config.token.is_empty() {
            return Err("KOOK bot token is required".to_string());
        }

        // Set status to connecting
        {
            let mut status = self.status.write().await;
            status.status = KookGatewayStatus::Connecting;
            status.error_message = None;
        }

        // Set running flag
        {
            let mut running = self.is_running.write().await;
            *running = true;
        }

        // Create shutdown channel
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        {
            let mut tx = self.shutdown_tx.write().await;
            *tx = Some(shutdown_tx);
        }

        // Clone necessary data for the async task
        let gateway = self.clone();
        let token = config.token.clone();

        // Spawn gateway loop
        tokio::spawn(async move {
            if let Err(e) = gateway.run_gateway_loop(token, shutdown_rx).await {
                println!("[KOOK] Gateway error: {}", e);
                let mut status = gateway.status.write().await;
                status.status = KookGatewayStatus::Error;
                status.error_message = Some(e);
            }

            // Set running to false when task exits
            let mut running = gateway.is_running.write().await;
            *running = false;
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let running = {
            let r = self.is_running.read().await;
            *r
        };

        if !running {
            return Ok(());
        }

        // Trigger shutdown
        {
            let mut tx_guard = self.shutdown_tx.write().await;
            if let Some(tx) = tx_guard.take() {
                let _ = tx.send(());
            }
        }

        // Wait for gateway to stop
        for _ in 0..50 {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            let running = self.is_running.read().await;
            if !*running {
                println!("[KOOK] Gateway stopped successfully");
                return Ok(());
            }
        }

        println!("[KOOK] Warning: Gateway did not stop within timeout, forcing stop");
        
        // Force reset state in case the wait timed out
        {
            let mut is_running = self.is_running.write().await;
            *is_running = false;
        }
        {
            let mut status = self.status.write().await;
            status.status = KookGatewayStatus::Disconnected;
            status.error_message = None;
            status.connected_guilds.clear();
        }
        
        println!("[KOOK] Gateway forcefully stopped");
        Ok(())
    }

    /// Main gateway loop: connect, handle events, reconnect on failure
    async fn run_gateway_loop(
        &self,
        token: String,
        mut shutdown_rx: oneshot::Receiver<()>,
    ) -> Result<(), String> {
        let mut backoff_secs = 2u64;
        let max_backoff = 60u64;

        loop {
            println!("[KOOK] Starting gateway connection...");

            match self.connect_and_run(&token, &mut shutdown_rx).await {
                Ok(WsExitReason::Shutdown) => {
                    println!("[KOOK] Shutdown requested, exiting gateway loop");
                    break;
                }
                Ok(WsExitReason::Disconnected) => {
                    println!("[KOOK] Connection ended, will reconnect...");
                    backoff_secs = 2;

                    {
                        let mut status = self.status.write().await;
                        status.status = KookGatewayStatus::Connecting;
                        status.error_message = Some("Reconnecting...".to_string());
                    }

                    tokio::select! {
                        _ = &mut shutdown_rx => {
                            println!("[KOOK] Shutdown during reconnect wait");
                            break;
                        }
                        _ = tokio::time::sleep(tokio::time::Duration::from_secs(backoff_secs)) => {}
                    }
                }
                Err(e) => {
                    println!("[KOOK] Connection error: {}", e);

                    {
                        let mut status = self.status.write().await;
                        status.status = KookGatewayStatus::Connecting;
                        status.error_message = Some(format!("Reconnecting after error: {}", e));
                    }

                    println!("[KOOK] Reconnecting in {} seconds...", backoff_secs);
                    tokio::select! {
                        _ = &mut shutdown_rx => {
                            println!("[KOOK] Shutdown during backoff wait");
                            break;
                        }
                        _ = tokio::time::sleep(tokio::time::Duration::from_secs(backoff_secs)) => {}
                    }
                    backoff_secs = std::cmp::min(backoff_secs * 2, max_backoff);
                }
            }
        }

        // Update status to disconnected
        let mut status = self.status.write().await;
        status.status = KookGatewayStatus::Disconnected;
        status.error_message = None;
        status.connected_guilds.clear();

        Ok(())
    }

    /// Fetch the bot's own user ID via /api/v3/user/me
    async fn fetch_bot_user_id(&self, token: &str) -> Result<String, String> {
        let client = reqwest::Client::new();
        let url = format!("{}/user/me", KOOK_API_BASE);

        let resp = client
            .get(&url)
            .header("Authorization", format!("Bot {}", token))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch bot user info: {}", e))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse user/me response: {}", e))?;

        let user_id = body["data"]["id"]
            .as_str()
            .ok_or_else(|| "No user ID in /user/me response".to_string())?
            .to_string();

        let username = body["data"]["username"]
            .as_str()
            .unwrap_or("Unknown");

        println!("[KOOK] Bot user ID: {}, username: {}", user_id, username);
        Ok(user_id)
    }

    /// Strip KOOK mention syntax from message content
    fn strip_mentions(&self, content: &str, bot_id: Option<&str>) -> String {
        let mut result = content.to_string();
        if let Some(id) = bot_id {
            result = result.replace(&format!("(met){}(met)", id), "");
        }
        result.trim().to_string()
    }

    /// Connect to KOOK WebSocket and handle events
    async fn connect_and_run(
        &self,
        token: &str,
        shutdown_rx: &mut oneshot::Receiver<()>,
    ) -> Result<WsExitReason, String> {
        // Reset sequence number for new connection
        self.last_sn.store(0, Ordering::SeqCst);
        println!("[KOOK] Reset sequence number for new connection");

        // Fetch bot user ID
        match self.fetch_bot_user_id(token).await {
            Ok(id) => {
                let mut bot_id = self.bot_user_id.write().await;
                *bot_id = Some(id);
            }
            Err(e) => {
                println!("[KOOK] Warning: Failed to fetch bot user ID: {}. Mentions won't be stripped.", e);
            }
        }
        
        // Get gateway URL
        let gateway_url = self.get_gateway_url(token).await?;
        println!("[KOOK] Gateway URL: {}", gateway_url);

        // Connect to WebSocket
        let (ws_stream, _) = connect_async(&gateway_url)
            .await
            .map_err(|e| format!("WebSocket connection failed: {}", e))?;

        let (write, mut read) = ws_stream.split();

        println!("[KOOK] WebSocket connected, waiting for HELLO...");

        // Wait for HELLO signal (s=1) within 6 seconds
        let hello_timeout = tokio::time::Duration::from_secs(6);
        let session_id = tokio::time::timeout(hello_timeout, async {
            while let Some(msg_result) = read.next().await {
                match msg_result {
                    Ok(WsMessage::Text(text)) => {
                        if let Ok(event) = serde_json::from_str::<KookEvent>(&text) {
                            if event.signal == Signal::Hello as u8 {
                                return self.handle_hello(event).await;
                            }
                        }
                    }
                    Ok(WsMessage::Binary(_)) => {
                        // Compressed message, we use compress=0 so this shouldn't happen
                        println!("[KOOK] Warning: Received binary message (compression enabled?)");
                    }
                    Ok(WsMessage::Close(_)) => {
                        return Err("Connection closed during HELLO".to_string());
                    }
                    Err(e) => {
                        return Err(format!("WebSocket error during HELLO: {}", e));
                    }
                    _ => {}
                }
            }
            Err("No HELLO received".to_string())
        })
        .await
        .map_err(|_| "HELLO timeout (6s)".to_string())??;

        println!("[KOOK] HELLO received, session_id: {}", session_id);

        // Store session ID
        {
            let mut ws_session = self.ws_session_id.write().await;
            *ws_session = Some(session_id.clone());
        }

        // Update status to connected
        {
            let mut status = self.status.write().await;
            status.status = KookGatewayStatus::Connected;
            status.error_message = None;
        }

        // Start heartbeat task
        let (heartbeat_tx, mut heartbeat_rx) = mpsc::channel::<()>(1);
        let last_sn_clone = self.last_sn.clone();
        let write_clone = Arc::new(tokio::sync::Mutex::new(write));
        let write_for_heartbeat = write_clone.clone();

        let heartbeat_task = tokio::spawn(async move {
            loop {
                // Wait for 30s ± 5s
                // Simple pseudo-random jitter using timestamp
                let jitter = (std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() % 11) as i64 - 5; // -5 to +5
                let wait_secs = (HEARTBEAT_INTERVAL_SECS as i64 + jitter).max(1) as u64;
                
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_secs(wait_secs)) => {
                        // Send PING
                        let sn = last_sn_clone.load(Ordering::SeqCst);
                        let ping = json!({
                            "s": Signal::Ping as u8,
                            "sn": sn
                        });
                        
                        let mut writer = write_for_heartbeat.lock().await;
                        if let Err(e) = writer.send(WsMessage::Text(ping.to_string())).await {
                            println!("[KOOK] Failed to send heartbeat: {}", e);
                            break;
                        }
                        drop(writer);
                        
                        // Wait for PONG (6s timeout)
                        match tokio::time::timeout(
                            tokio::time::Duration::from_secs(HEARTBEAT_TIMEOUT_SECS),
                            heartbeat_rx.recv()
                        ).await {
                            Ok(Some(())) => {
                                // PONG received
                            }
                            _ => {
                                println!("[KOOK] Heartbeat timeout");
                                break;
                            }
                        }
                    }
                    _ = heartbeat_rx.recv() => {
                        // Shutdown signal
                        break;
                    }
                }
            }
        });

        // Message buffer for out-of-order handling
        let mut message_buffer: VecDeque<(u64, KookMessageData)> = VecDeque::new();

        // Main event loop
        let mut exit_reason = WsExitReason::Disconnected;
        let mut _shutdown_fired = false;
        loop {
            tokio::select! {
                msg_result = read.next() => {
                    match msg_result {
                        Some(Ok(WsMessage::Text(text))) => {
                            if let Err(e) = self.handle_ws_message(&text, &heartbeat_tx, &mut message_buffer).await {
                                println!("[KOOK] Error handling message: {}", e);
                                if e.contains("Reconnect requested") {
                                    println!("[KOOK] Server requested reconnection, closing connection");
                                    break;
                                }
                            }
                        }
                        Some(Ok(WsMessage::Close(_))) => {
                            println!("[KOOK] WebSocket closed by server");
                            break;
                        }
                        Some(Err(e)) => {
                            println!("[KOOK] WebSocket error: {}", e);
                            break;
                        }
                        None => {
                            println!("[KOOK] WebSocket stream ended");
                            break;
                        }
                        _ => {}
                    }
                }
                _ = &mut *shutdown_rx, if !_shutdown_fired => {
                    println!("[KOOK] Shutdown requested");
                    _shutdown_fired = true;
                    exit_reason = WsExitReason::Shutdown;
                    break;
                }
            }
        }

        // Cleanup
        heartbeat_task.abort();
        let mut writer = write_clone.lock().await;
        let _ = writer.close().await;

        Ok(exit_reason)
    }

    /// Get gateway WebSocket URL from KOOK API
    async fn get_gateway_url(&self, token: &str) -> Result<String, String> {
        let client = reqwest::Client::new();
        let url = format!("{}/gateway/index?compress=0", KOOK_API_BASE);

        let resp = client
            .get(&url)
            .header("Authorization", format!("Bot {}", token))
            .send()
            .await
            .map_err(|e| format!("Failed to get gateway: {}", e))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse gateway response: {}", e))?;

        if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
            if code != 0 {
                let message = body.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("Gateway API error ({}): {}", code, message));
            }
        }

        body.get("data")
            .and_then(|d| d.get("url"))
            .and_then(|u| u.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "No gateway URL in response".to_string())
    }

    /// Handle HELLO signal (s=1)
    async fn handle_hello(&self, event: KookEvent) -> Result<String, String> {
        let code = event.data.get("code")
            .and_then(|c| c.as_i64())
            .unwrap_or(-1);

        if code != 0 {
            return Err(format!("HELLO failed with code: {}", code));
        }

        let session_id = event.data.get("session_id")
            .and_then(|s| s.as_str())
            .ok_or("No session_id in HELLO")?
            .to_string();

        Ok(session_id)
    }

    /// Handle incoming WebSocket message
    async fn handle_ws_message(
        &self,
        text: &str,
        heartbeat_tx: &mpsc::Sender<()>,
        message_buffer: &mut VecDeque<(u64, KookMessageData)>,
    ) -> Result<(), String> {
        let event: KookEvent = serde_json::from_str(text)
            .map_err(|e| format!("Failed to parse event: {}", e))?;

        match event.signal {
            s if s == Signal::Event as u8 => {
                // Message or system event
                if let Some(sn) = event.sn {
                    self.handle_event(sn, event.data, message_buffer).await?;
                }
            }
            s if s == Signal::Pong as u8 => {
                // Heartbeat PONG
                let _ = heartbeat_tx.try_send(());
            }
            s if s == Signal::Reconnect as u8 => {
                // Server requests reconnection
                println!("[KOOK] Received RECONNECT signal");
                return Err("Reconnect requested by server".to_string());
            }
            s if s == Signal::ResumeAck as u8 => {
                // Resume successful
                println!("[KOOK] Resume ACK received");
            }
            _ => {
                println!("[KOOK] Unknown signal: {}", event.signal);
            }
        }

        Ok(())
    }

    /// Handle EVENT signal (s=0) - messages and system events
    async fn handle_event(
        &self,
        sn: u64,
        data: serde_json::Value,
        message_buffer: &mut VecDeque<(u64, KookMessageData)>,
    ) -> Result<(), String> {
        let last_sn = self.last_sn.load(Ordering::SeqCst);

        // Check message ordering
        if sn <= last_sn {
            // Already processed, skip
            println!("[KOOK] Skipping duplicate sn: {}", sn);
            return Ok(());
        }

        if sn == last_sn + 1 {
            // In-order message, process immediately
            match self.process_message_data(sn, data).await {
                Ok(_) => {},
                Err(e) => {
                    println!("[KOOK] Error handling message: {}", e);
                }
            }
            // Update last_sn even if processing failed to maintain sequence continuity
            self.last_sn.store(sn, Ordering::SeqCst);

            // Process any buffered messages that are now in order
            while let Some((buffered_sn, _)) = message_buffer.front() {
                if *buffered_sn == self.last_sn.load(Ordering::SeqCst) + 1 {
                    if let Some((sn, data_value)) = message_buffer.pop_front() {
                        let data_json = data_value.to_json();
                        match self.process_message_data(sn, data_json).await {
                            Ok(_) => {},
                            Err(e) => {
                                println!("[KOOK] Error handling buffered message: {}", e);
                            }
                        }
                        // Update last_sn even if processing failed
                        self.last_sn.store(sn, Ordering::SeqCst);
                    }
                } else {
                    break;
                }
            }
        } else {
            // Out-of-order message, buffer it
            println!("[KOOK] Buffering out-of-order message: sn={} (expected={})", sn, last_sn + 1);
            
            if let Ok(msg_data) = serde_json::from_value::<KookMessageData>(data) {
                message_buffer.push_back((sn, msg_data));
                
                // Sort buffer by sn
                message_buffer.make_contiguous().sort_by_key(|(sn, _)| *sn);
                
                // Limit buffer size
                if message_buffer.len() > MAX_BUFFER_SIZE {
                    println!("[KOOK] Warning: Message buffer full, dropping oldest");
                    message_buffer.pop_front();
                }
            }
        }

        Ok(())
    }

    /// Process a message event
    async fn process_message_data(
        &self,
        sn: u64,
        data: serde_json::Value,
    ) -> Result<(), String> {
        let msg_data: KookMessageData = serde_json::from_value(data)
            .map_err(|e| format!("Failed to parse message data: {}", e))?;

        println!("[KOOK] Event sn={}, channel_type={}, msg_id={}", 
            sn, msg_data.channel_type, msg_data.msg_id);

        // Check if already processed
        if self.mark_message_processed(&msg_data.msg_id).await {
            println!("[KOOK] Skipping duplicate message: {}", msg_data.msg_id);
            return Ok(());
        }

        // Check if this is a reply to a pending question (KOOK uses extra.quote)
        if let Some(quote_id) = msg_data.extra.get("quote")
            .and_then(|q| q.get("rong_id").or_else(|| q.get("id")))
            .and_then(|id| id.as_str())
        {
            if let Some(entry) = self.pending_questions.take(quote_id).await {
                let _ = entry.answer_tx.send(msg_data.content.clone());
                println!("[KOOK] Question {} answered via quote reply", entry.question_id);
                return Ok(());
            }
        }

        // Filter message
        let filter_result = self.filter_message(&msg_data).await;
        
        match filter_result {
            FilterResult::Allow => {
                self.process_and_reply(&msg_data).await?;
            }
            FilterResult::Ignore => {
                println!("[KOOK] Message filtered (ignore)");
            }
            FilterResult::UserNotAllowed => {
                println!("[KOOK] User not in allowlist: {}", msg_data.author_id);
                self.send_rejection_reply(&msg_data).await?;
            }
            FilterResult::ChannelNotConfigured => {
                println!("[KOOK] Channel not configured");
                self.send_config_hint(&msg_data).await?;
            }
        }

        Ok(())
    }

    /// Check if a message has been processed, and mark it if not
    async fn mark_message_processed(&self, msg_id: &str) -> bool {
        let mut tracker = self.processed_messages.write().await;
        tracker.is_duplicate(msg_id)
    }

    /// Filter message based on configuration
    async fn filter_message(&self, msg: &KookMessageData) -> FilterResult {
        let config = self.config.read().await;

        // Ignore bot messages
        if let Some(author) = msg.extra.get("author") {
            if author.get("bot").and_then(|b| b.as_bool()).unwrap_or(false) {
                return FilterResult::Ignore;
            }
        }

        match msg.channel_type.as_str() {
            "PERSON" => {
                // Direct message
                if !config.dm.enabled {
                    return FilterResult::Ignore;
                }

                match config.dm.policy.as_str() {
                    "open" => FilterResult::Allow,
                    "allowlist" => {
                        if config.dm.allow_from.contains(&msg.author_id)
                            || config.dm.allow_from.contains(&"*".to_string()) {
                            FilterResult::Allow
                        } else {
                            FilterResult::UserNotAllowed
                        }
                    }
                    _ => FilterResult::Allow,
                }
            }
            "GROUP" => {
                // Guild channel message
                let guild_id = msg.extra.get("guild_id")
                    .and_then(|g| g.as_str())
                    .unwrap_or("");

                println!("[KOOK] GROUP message: guild_id={}, channel_id={}", guild_id, msg.target_id);
                println!("[KOOK] Configured guilds: {:?}", config.guilds.keys().collect::<Vec<_>>());

                if guild_id.is_empty() {
                    return FilterResult::Ignore;
                }

                // Check if guild is configured (exact match or wildcard)
                let guild_cfg = config.guilds.get(guild_id)
                    .or_else(|| config.guilds.get("*"));

                let Some(guild_cfg) = guild_cfg else {
                    return FilterResult::ChannelNotConfigured;
                };

                if !guild_cfg.enabled {
                    return FilterResult::Ignore;
                }

                // Check channel configuration (exact match or wildcard)
                let channel_rule = guild_cfg.channels.get(&msg.target_id)
                    .or_else(|| guild_cfg.channels.get("*"));

                if let Some(rule) = channel_rule {
                    if !rule.enabled {
                        return FilterResult::Ignore;
                    }

                    // Check user allowlist (channel-specific)
                    if !rule.allowed_users.is_empty() 
                        && !rule.allowed_users.contains(&msg.author_id)
                        && !rule.allowed_users.contains(&"*".to_string()) {
                        return FilterResult::UserNotAllowed;
                    }

                    // Check if @mention is required
                    if rule.require_mention {
                        let bot_id = self.bot_user_id.read().await;
                        let bot_mentioned = if let Some(ref id) = *bot_id {
                            msg.content.contains(&format!("(met){}(met)", id))
                        } else {
                            msg.content.contains("(met)")
                        };
                        drop(bot_id);
                        if !bot_mentioned && !msg.content.starts_with('/') {
                            return FilterResult::Ignore;
                        }
                    }

                    FilterResult::Allow
                } else {
                    // No specific channel rule, but guild is configured - allow by default
                    FilterResult::Allow
                }
            }
            _ => FilterResult::Ignore,
        }
    }

    /// Process message and send reply
    async fn process_and_reply(&self, msg: &KookMessageData) -> Result<(), String> {
        let config = self.config.read().await;
        
        // Build session key
        let session_key = if msg.channel_type == "PERSON" {
            format!("kook:dm:{}", msg.author_id)
        } else {
            let guild_id = msg.extra.get("guild_id")
                .and_then(|g| g.as_str())
                .unwrap_or("");
            format!("kook:channel:{}:{}", guild_id, msg.target_id)
        };

        // Determine which session_id to use (from config or session mapping)
        // Note: DM always uses session mapping, only guild channels support configured session_id
        let configured_session_id = if msg.channel_type == "PERSON" {
            None
        } else {
            let guild_id = msg.extra.get("guild_id")
                .and_then(|g| g.as_str())
                .unwrap_or("");
            config.guilds.get(guild_id)
                .and_then(|guild| guild.channels.get(&msg.target_id))
                .and_then(|ch| ch.session_id.clone())
        };

        // Get or create session
        let session_id = if let Some(configured_id) = configured_session_id {
            // Use configured session_id
            configured_id
        } else {
            // Use session mapping
            match self.session_mapping.get_session(&session_key).await {
                Some(id) => id,
                None => {
                    let new_id = self.create_opencode_session().await?;
                    self.session_mapping.set_session(session_key.clone(), new_id.clone()).await;
                    new_id
                }
            }
        };
        
        drop(config);

        // Strip bot mention from content (like Discord strips <@BOTID>)
        let bot_id = self.bot_user_id.read().await;
        let content = self.strip_mentions(&msg.content, bot_id.as_deref());
        drop(bot_id);

        // Check for /answer command — routes reply to the most recent pending question
        if let Some(answer_text) = super::PendingQuestionStore::parse_answer_command(&content) {
            if let Some(qid) = self.pending_questions.try_answer(answer_text).await {
                println!("[KOOK] Question {} answered via /answer: {}", qid, answer_text);
                let _ = self.send_reply(msg, &format!("✓ 已回复: {}", answer_text)).await;
            } else {
                let _ = self.send_reply(msg, "当前没有待回复的问题").await;
            }
            return Ok(());
        }

        // Check for slash commands
        if content.starts_with('/') {
            return self.handle_slash_command(&session_key, &content, msg).await;
        }

        // Look up model preference for this context (like Discord)
        let model_param = self
            .session_mapping
            .get_model(&session_key)
            .await
            .and_then(|m| super::parse_model_preference(&m));

        // Build question context for forwarding AI questions to the channel
        let pending_questions_clone = Arc::clone(&self.pending_questions);
        let qctx_config = self.config.read().await.clone();
        let target = if msg.channel_type == "PERSON" {
            msg.author_id.clone()
        } else {
            msg.target_id.clone()
        };
        let channel_type = msg.channel_type.clone();
        let question_ctx = super::QuestionContext {
            forwarder: Box::new(move |fq: super::ForwardedQuestion| {
                let token = qctx_config.token.clone();
                let target = target.clone();
                let ct = channel_type.clone();
                Box::pin(async move {
                    let text = super::format_question_message(&fq.questions, &fq.question_id);
                    let client = reqwest::Client::new();
                    let (url, body) = if ct == "PERSON" {
                        ("https://www.kookapp.cn/api/v3/direct-message/create".to_string(),
                         serde_json::json!({ "target_id": target, "type": 1, "content": text }))
                    } else {
                        ("https://www.kookapp.cn/api/v3/message/create".to_string(),
                         serde_json::json!({ "target_id": target, "type": 1, "content": text }))
                    };
                    let resp = client.post(&url)
                        .header("Authorization", format!("Bot {}", token))
                        .json(&body)
                        .send().await
                        .map_err(|e| format!("KOOK send failed: {}", e))?;
                    let json: serde_json::Value = resp.json().await
                        .map_err(|e| format!("KOOK parse failed: {}", e))?;
                    json.get("data")
                        .and_then(|d| d.get("msg_id"))
                        .and_then(|id| id.as_str())
                        .map(|s| s.to_string())
                        .ok_or_else(|| "No msg_id in KOOK response".to_string())
                })
            }),
            store: pending_questions_clone,
        };

        // Send "Thinking..." card message first
        let thinking_msg_id = self.send_thinking_card(msg).await?;

        // Send to OpenCode
        let response = match self.send_to_opencode(&session_id, &content, model_param.clone(), Some(question_ctx)).await {
            Ok(resp) => resp,
            Err(e) => {
                // Update the thinking message with error
                let error_text = format!("❌ Error: {}", e);
                let _ = self.update_card_message(&thinking_msg_id, &error_text, msg.channel_type == "PERSON").await;
                return Err(e);
            }
        };

        // Update the thinking message with actual response
        self.update_card_message(&thinking_msg_id, &response, msg.channel_type == "PERSON").await?;

        Ok(())
    }

    /// Create new OpenCode session
    async fn create_opencode_session(&self) -> Result<String, String> {
        super::create_opencode_session(self.opencode_port).await
    }

    /// Send message to OpenCode using async mode with permission auto-approval
    async fn send_to_opencode(
        &self,
        session_id: &str,
        message: &str,
        model: Option<(String, String)>,
        question_ctx: Option<super::QuestionContext>,
    ) -> Result<String, String> {
        println!("[KOOK] Sending message asynchronously with permission auto-approval");

        let parts = vec![json!({"type": "text", "text": message})];

        // Use async send with permission auto-approval
        super::send_message_async_with_approval(
            self.opencode_port,
            session_id,
            parts,
            model,
            question_ctx,
        ).await
    }

    /// Send "Thinking..." card message and return msg_id
    async fn send_thinking_card(&self, original: &KookMessageData) -> Result<String, String> {
        let config = self.config.read().await;
        let client = reqwest::Client::new();

        // Create a simple card with "Thinking..." text
        let card = json!([
            {
                "type": "card",
                "theme": "secondary",
                "size": "sm",
                "modules": [
                    {
                        "type": "section",
                        "text": {
                            "type": "plain-text",
                            "content": "🤔 Thinking..."
                        }
                    }
                ]
            }
        ]);

        let (endpoint, payload) = if original.channel_type == "PERSON" {
            let url = format!("{}/direct-message/create", KOOK_API_BASE);
            let body = json!({
                "type": 10,  // Card message
                "target_id": original.author_id,
                "content": serde_json::to_string(&card).unwrap(),
                "quote": original.msg_id  // Reply to original message
            });
            (url, body)
        } else {
            let url = format!("{}/message/create", KOOK_API_BASE);
            let body = json!({
                "type": 10,  // Card message
                "target_id": original.target_id,
                "content": serde_json::to_string(&card).unwrap(),
                "quote": original.msg_id  // Reply to original message
            });
            (url, body)
        };

        let resp = client
            .post(&endpoint)
            .header("Authorization", format!("Bot {}", config.token))
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Failed to send thinking card: {}", e))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse thinking card response: {}", e))?;

        if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
            if code != 0 {
                let message = body.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("KOOK API error ({}): {}", code, message));
            }
        }

        // Extract msg_id from response
        body.get("data")
            .and_then(|d| d.get("msg_id"))
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "No msg_id in response".to_string())
    }

    /// Update card message with actual content
    async fn update_card_message(&self, msg_id: &str, content: &str, is_dm: bool) -> Result<(), String> {
        let config = self.config.read().await;
        let client = reqwest::Client::new();

        // Create card with the actual content
        let card = json!([
            {
                "type": "card",
                "theme": "primary",
                "size": "lg",
                "modules": [
                    {
                        "type": "section",
                        "text": {
                            "type": "kmarkdown",
                            "content": content
                        }
                    }
                ]
            }
        ]);

        let endpoint = if is_dm {
            format!("{}/direct-message/update", KOOK_API_BASE)
        } else {
            format!("{}/message/update", KOOK_API_BASE)
        };

        let payload = json!({
            "msg_id": msg_id,
            "content": serde_json::to_string(&card).unwrap()
        });

        let resp = client
            .post(&endpoint)
            .header("Authorization", format!("Bot {}", config.token))
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Failed to update card: {}", e))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse update response: {}", e))?;

        if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
            if code != 0 {
                let message = body.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("KOOK API error ({}): {}", code, message));
            }
        }

        Ok(())
    }

    /// Send reply via KOOK HTTP API using card message for rich formatting
    async fn send_reply(&self, original: &KookMessageData, reply_text: &str) -> Result<(), String> {
        let config = self.config.read().await;
        let client = reqwest::Client::new();

        let card = json!([
            {
                "type": "card",
                "theme": "primary",
                "size": "lg",
                "modules": [
                    {
                        "type": "section",
                        "text": {
                            "type": "kmarkdown",
                            "content": reply_text
                        }
                    }
                ]
            }
        ]);

        let (endpoint, payload) = if original.channel_type == "PERSON" {
            let url = format!("{}/direct-message/create", KOOK_API_BASE);
            let body = json!({
                "type": 10,
                "target_id": original.author_id,
                "content": serde_json::to_string(&card).unwrap(),
                "quote": original.msg_id,
            });
            (url, body)
        } else {
            let url = format!("{}/message/create", KOOK_API_BASE);
            let body = json!({
                "type": 10,
                "target_id": original.target_id,
                "content": serde_json::to_string(&card).unwrap(),
                "quote": original.msg_id,
            });
            (url, body)
        };

        let resp = client
            .post(&endpoint)
            .header("Authorization", format!("Bot {}", config.token))
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Failed to send reply: {}", e))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse reply response: {}", e))?;

        if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
            if code != 0 {
                let message = body.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("Reply API error ({}): {}", code, message));
            }
        }

        Ok(())
    }

    /// Handle slash commands
    async fn handle_slash_command(
        &self,
        session_key: &str,
        content: &str,
        msg: &KookMessageData,
    ) -> Result<(), String> {
        let parts: Vec<&str> = content.trim().split_whitespace().collect();
        let command = parts.first().map(|s| s.to_lowercase()).unwrap_or_default();
        let arg = parts.get(1..).map(|s| s.join(" ")).unwrap_or_default();

        match command.as_str() {
            "/reset" => {
                self.session_mapping.remove_session(session_key).await;
                self.send_reply(msg, "Session reset! A new conversation will start with your next message.").await?;
            }
            "/model" if arg.is_empty() => {
                // List models - use dedicated card layout
                self.send_model_list_card(session_key, msg).await?;
            }
            "/model" => {
                let response = super::handle_model_command(
                    self.opencode_port,
                    &self.session_mapping,
                    session_key,
                    &arg,
                ).await;
                self.send_reply(msg, &response).await?;
            }
            "/sessions" => {
                let response = super::handle_sessions_command(
                    self.opencode_port,
                    &self.session_mapping,
                    session_key,
                    &arg,
                ).await;
                self.send_reply(msg, &response).await?;
            }
            "/stop" => {
                let response = super::handle_stop_command(
                    self.opencode_port,
                    &self.session_mapping,
                    session_key,
                ).await;
                self.send_reply(msg, &response).await?;
            }
            "/help" => {
                self.send_help_card(msg).await?;
            }
            _ => {
                return Ok(());
            }
        }

        Ok(())
    }

    /// Send model list as a well-structured multi-module card
    async fn send_model_list_card(&self, session_key: &str, msg: &KookMessageData) -> Result<(), String> {
        let (models, default_model) = super::opencode_get_available_models(self.opencode_port).await
            .map_err(|e| format!("Failed to get models: {}", e))?;

        let stored = self.session_mapping.get_model(session_key).await;
        let (active, is_custom) = match &stored {
            Some(m) => (m.as_str(), true),
            None => (default_model.as_str(), false),
        };

        let current_label = if is_custom { "custom" } else { "default" };

        // Group models by provider
        let mut provider_groups: std::collections::BTreeMap<String, Vec<&super::ModelInfo>> = std::collections::BTreeMap::new();
        for m in &models {
            provider_groups.entry(m.provider.clone()).or_default().push(m);
        }

        // Build card modules
        let mut modules: Vec<serde_json::Value> = vec![
            json!({
                "type": "header",
                "text": { "type": "plain-text", "content": "Available Models" }
            }),
            json!({
                "type": "section",
                "text": {
                    "type": "kmarkdown",
                    "content": format!("**Current Model:** {} ({})", active, current_label)
                }
            }),
            json!({ "type": "divider" }),
        ];

        // Add each provider as a separate section
        for (provider, provider_models) in &provider_groups {
            let lines: Vec<String> = provider_models.iter().map(|m| {
                let full_id = format!("{}/{}", m.provider, m.id);
                let marker = if full_id == active { " ← current" } else { "" };
                format!("{} ({}){}", full_id, m.name, marker)
            }).collect();

            let section_text = format!("**{}**\n{}", provider, lines.join("\n"));

            modules.push(json!({
                "type": "section",
                "text": {
                    "type": "kmarkdown",
                    "content": section_text
                }
            }));

            // KOOK card limits: max 50 modules
            if modules.len() > 45 {
                modules.push(json!({
                    "type": "section",
                    "text": {
                        "type": "kmarkdown",
                        "content": "_(List truncated. Visit OpenCode UI for full model list.)_"
                    }
                }));
                break;
            }
        }

        modules.push(json!({ "type": "divider" }));
        modules.push(json!({
            "type": "context",
            "elements": [{
                "type": "kmarkdown",
                "content": "Use `/model provider/model` to switch. Use `/model default` to reset."
            }]
        }));

        let card = json!([{
            "type": "card",
            "theme": "info",
            "size": "lg",
            "modules": modules
        }]);

        self.send_card_direct(msg, &card).await
    }

    /// Send help as a well-structured card
    async fn send_help_card(&self, msg: &KookMessageData) -> Result<(), String> {
        let card = json!([{
            "type": "card",
            "theme": "info",
            "size": "lg",
            "modules": [
                {
                    "type": "header",
                    "text": { "type": "plain-text", "content": "TeamClaw Bot Commands" }
                },
                {
                    "type": "section",
                    "text": {
                        "type": "kmarkdown",
                        "content": "/reset - Reset the current chat session\n/model - View current model or switch models\n/sessions - List or switch sessions\n/stop - Stop the current processing\n/help - Show this help message"
                    }
                },
                { "type": "divider" },
                {
                    "type": "context",
                    "elements": [{
                        "type": "kmarkdown",
                        "content": "In DMs: Just send a message to start chatting. In channels: Send messages directly."
                    }]
                }
            ]
        }]);

        self.send_card_direct(msg, &card).await
    }

    /// Send a raw card JSON message
    async fn send_card_direct(&self, original: &KookMessageData, card: &serde_json::Value) -> Result<(), String> {
        let config = self.config.read().await;
        let client = reqwest::Client::new();

        let (endpoint, payload) = if original.channel_type == "PERSON" {
            let url = format!("{}/direct-message/create", KOOK_API_BASE);
            let body = json!({
                "type": 10,
                "target_id": original.author_id,
                "content": serde_json::to_string(card).unwrap(),
                "quote": original.msg_id,
            });
            (url, body)
        } else {
            let url = format!("{}/message/create", KOOK_API_BASE);
            let body = json!({
                "type": 10,
                "target_id": original.target_id,
                "content": serde_json::to_string(card).unwrap(),
                "quote": original.msg_id,
            });
            (url, body)
        };

        let resp = client
            .post(&endpoint)
            .header("Authorization", format!("Bot {}", config.token))
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Failed to send card: {}", e))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
            if code != 0 {
                let message = body.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("KOOK API error ({}): {}", code, message));
            }
        }

        Ok(())
    }

    /// Send rejection reply for users not in allowlist
    async fn send_rejection_reply(&self, msg: &KookMessageData) -> Result<(), String> {
        let reply = "This is an automated response from TeamClaw. \
            Your user ID is not in the allowed list. \
            Please contact the administrator if you believe this is an error.";
        self.send_reply(msg, reply).await
    }

    /// Send configuration hint
    async fn send_config_hint(&self, msg: &KookMessageData) -> Result<(), String> {
        let reply = "This channel is not configured for TeamClaw bot. \
            Please configure it in the TeamClaw settings.";
        self.send_reply(msg, reply).await
    }
}

impl Clone for KookGateway {
    fn clone(&self) -> Self {
        Self {
            config: Arc::clone(&self.config),
            session_mapping: self.session_mapping.clone(),
            opencode_port: self.opencode_port,
            shutdown_tx: Arc::clone(&self.shutdown_tx),
            status: Arc::clone(&self.status),
            is_running: Arc::clone(&self.is_running),
            ws_session_id: Arc::clone(&self.ws_session_id),
            last_sn: Arc::clone(&self.last_sn),
            processed_messages: Arc::clone(&self.processed_messages),
            bot_user_id: Arc::clone(&self.bot_user_id),
            permission_approver: self.permission_approver.clone(),
            pending_questions: Arc::clone(&self.pending_questions),
        }
    }
}

// ==================== Standalone HTTP Message Sender ====================

/// Send a KOOK message via HTTP API (for cron jobs, etc.)
pub async fn send_kook_message_http(
    token: &str,
    target_id: &str,
    content: &str,
    is_dm: bool,
) -> Result<(), String> {
    let client = reqwest::Client::new();

    let (endpoint, payload) = if is_dm {
        let url = format!("{}/direct-message/create", KOOK_API_BASE);
        let body = json!({
            "type": 1,
            "target_id": target_id,
            "content": content,
        });
        (url, body)
    } else {
        let url = format!("{}/message/create", KOOK_API_BASE);
        let body = json!({
            "type": 1,
            "target_id": target_id,
            "content": content,
        });
        (url, body)
    };

    let resp = client
        .post(&endpoint)
        .header("Authorization", format!("Bot {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send message: {}", e))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
        if code != 0 {
            let message = body.get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error");
            return Err(format!("KOOK API error ({}): {}", code, message));
        }
    }

    Ok(())
}
