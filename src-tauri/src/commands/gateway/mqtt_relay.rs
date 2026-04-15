// src-tauri/src/commands/gateway/mqtt_relay.rs

use futures_util::StreamExt;
use prost::Message as ProstMessage;
use rumqttc::v5::mqttbytes::QoS;
use rumqttc::v5::{AsyncClient, Event, Incoming, MqttOptions};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex as TokioMutex, RwLock};
use tokio::task::JoinHandle;

use super::mqtt_proto::proto;
use crate::commands::team_unified::{MemberRole, TeamManifest};
use teamclaw_gateway::mqtt_config::{MqttConfig, MqttRelayStatus, PairedDevice, PairingSession};

// ─── TLS ──────────────────────────────────────────────────────────────────────

#[derive(Debug)]
struct NoVerifier;

impl rustls::client::danger::ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// MQTT relay bridging the iOS mobile client to the local OpenCode Agent.
pub struct MqttRelay {
    config: Arc<RwLock<MqttConfig>>,
    client: Arc<TokioMutex<Option<AsyncClient>>>,
    event_loop_handle: Arc<TokioMutex<Option<JoinHandle<()>>>>,
    opencode_port: u16,
    workspace_path: String,
    is_connected: Arc<std::sync::atomic::AtomicBool>,
    pairing_session: Arc<TokioMutex<Option<PairingSession>>>,
    error_message: Arc<RwLock<Option<String>>>,
    oss_sync_state:
        Option<Arc<tokio::sync::Mutex<Option<crate::commands::oss_sync::OssSyncManager>>>>,
    /// Cancel tokens for active SSE streams, keyed by session_id.
    cancel_tokens:
        Arc<TokioMutex<std::collections::HashMap<String, tokio_util::sync::CancellationToken>>>,
    /// Active collaborative session IDs this relay is hosting as Agent.
    /// Maps collab_session_id → opencode_session_id
    collab_sessions: Arc<TokioMutex<std::collections::HashMap<String, String>>>,
}

impl Clone for MqttRelay {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            client: self.client.clone(),
            event_loop_handle: self.event_loop_handle.clone(),
            opencode_port: self.opencode_port,
            workspace_path: self.workspace_path.clone(),
            is_connected: self.is_connected.clone(),
            pairing_session: self.pairing_session.clone(),
            error_message: self.error_message.clone(),
            oss_sync_state: self.oss_sync_state.clone(),
            cancel_tokens: self.cancel_tokens.clone(),
            collab_sessions: self.collab_sessions.clone(),
        }
    }
}

impl MqttRelay {
    pub fn new(opencode_port: u16, workspace_path: String) -> Self {
        Self {
            config: Arc::new(RwLock::new(MqttConfig::default())),
            client: Arc::new(TokioMutex::new(None)),
            event_loop_handle: Arc::new(TokioMutex::new(None)),
            opencode_port,
            workspace_path,
            is_connected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pairing_session: Arc::new(TokioMutex::new(None)),
            error_message: Arc::new(RwLock::new(None)),
            oss_sync_state: None,
            cancel_tokens: Arc::new(TokioMutex::new(std::collections::HashMap::new())),
            collab_sessions: Arc::new(TokioMutex::new(std::collections::HashMap::new())),
        }
    }

    async fn resolve_or_create_opencode_session(
        &self,
        port: u16,
        mobile_session_id: &str,
    ) -> Result<String, String> {
        // Check in-memory collab map first
        if let Some(id) = self.collab_sessions.lock().await.get(mobile_session_id).cloned() {
            return Ok(id);
        }
        // Create new OpenCode session
        let oc_id = teamclaw_gateway::create_opencode_session(port).await?;
        eprintln!(
            "[MQTT Relay] Created OpenCode session {} for mobile session {}",
            oc_id, mobile_session_id
        );
        self.collab_sessions
            .lock()
            .await
            .insert(mobile_session_id.to_string(), oc_id.clone());
        Ok(oc_id)
    }

    /// Set the OssSyncState reference so the relay can read members from S3.
    pub fn set_oss_sync_state(
        &mut self,
        state: Arc<tokio::sync::Mutex<Option<crate::commands::oss_sync::OssSyncManager>>>,
    ) {
        self.oss_sync_state = Some(state);
    }

    pub async fn set_config(&self, config: MqttConfig) {
        *self.config.write().await = config;
    }

    pub async fn get_config(&self) -> MqttConfig {
        self.config.read().await.clone()
    }

    pub async fn get_status(&self) -> MqttRelayStatus {
        let config = self.config.read().await;
        MqttRelayStatus {
            connected: self.is_connected.load(std::sync::atomic::Ordering::Relaxed),
            broker_host: if config.broker_host.is_empty() {
                None
            } else {
                Some(config.broker_host.clone())
            },
            paired_device_count: config.paired_devices.len(),
            error_message: self.error_message.read().await.clone(),
        }
    }

    // ─── Connection ────────────────────────────────────────────

    pub async fn start(&self) -> Result<(), String> {
        let config = self.config.read().await.clone();

        if config.broker_host.is_empty() {
            return Err("MQTT broker host not configured".to_string());
        }

        let client_id = format!(
            "teamclaw-desktop-{}",
            &config.device_id[..8.min(config.device_id.len())]
        );
        let mut mqttoptions = MqttOptions::new(&client_id, &config.broker_host, config.broker_port);
        mqttoptions.set_credentials(&config.username, &config.password);
        mqttoptions.set_keep_alive(Duration::from_secs(60));
        mqttoptions.set_clean_start(false);

        let _ = rustls::crypto::ring::default_provider().install_default();
        if config.tls_insecure {
            let tls_config = rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoVerifier))
                .with_no_client_auth();
            mqttoptions.set_transport(rumqttc::Transport::tls_with_config(tls_config.into()));
        } else {
            mqttoptions.set_transport(rumqttc::Transport::tls_with_default_config());
        }

        let (client, mut eventloop) = AsyncClient::new(mqttoptions, 100);

        let team_id = config.team_id.clone();
        for device in &config.paired_devices {
            let topic = format!("teamclaw/{}/{}/chat/req", team_id, device.device_id);
            client
                .subscribe(&topic, QoS::AtLeastOnce)
                .await
                .map_err(|e| format!("Subscribe failed: {}", e))?;
        }

        self.publish_status(&client, &config, true).await?;

        *self.client.lock().await = Some(client);
        self.is_connected
            .store(true, std::sync::atomic::Ordering::Relaxed);
        *self.error_message.write().await = None;

        let relay = self.clone();
        let handle = tokio::spawn(async move {
            loop {
                match eventloop.poll().await {
                    Ok(Event::Incoming(Incoming::Publish(publish))) => {
                        let topic = String::from_utf8_lossy(&publish.topic).to_string();
                        let payload_bytes = publish.payload.to_vec();
                        let relay_clone = relay.clone();
                        tokio::spawn(async move {
                            if let Err(e) = relay_clone
                                .handle_incoming_message(&topic, &payload_bytes)
                                .await
                            {
                                eprintln!("[MQTT Relay] Error handling message: {}", e);
                            }
                        });
                    }
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("[MQTT Relay] Event loop error: {}", e);
                        relay
                            .is_connected
                            .store(false, std::sync::atomic::Ordering::Relaxed);
                        *relay.error_message.write().await = Some(format!("{}", e));
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        });

        *self.event_loop_handle.lock().await = Some(handle);
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        if let Some(client) = self.client.lock().await.as_ref() {
            let config = self.config.read().await.clone();
            let _ = self.publish_status(client, &config, false).await;
            let _ = client.disconnect().await;
        }

        if let Some(handle) = self.event_loop_handle.lock().await.take() {
            handle.abort();
        }

        *self.client.lock().await = None;
        self.is_connected
            .store(false, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    // ─── Publishing helpers ────────────────────────────────────

    async fn publish_status(
        &self,
        client: &AsyncClient,
        config: &MqttConfig,
        online: bool,
    ) -> Result<(), String> {
        let status_topic = format!("teamclaw/{}/{}/status", config.team_id, config.device_id);
        let msg = build_envelope(proto::mqtt_message::Payload::StatusReport(
            proto::StatusReport {
                online,
                device_name: if online {
                    Some(config.device_name.clone())
                } else {
                    None
                },
                available_models: vec![],
            },
        ));
        client
            .publish(&status_topic, QoS::AtLeastOnce, true, msg.encode_to_vec())
            .await
            .map_err(|e| format!("Status publish failed: {}", e))
    }

    async fn publish_proto_to_device(
        &self,
        device_id: &str,
        subtopic: &str,
        msg: &proto::MqttMessage,
    ) -> Result<(), String> {
        let config = self.config.read().await;
        let topic = format!("teamclaw/{}/{}/{}", config.team_id, device_id, subtopic);
        let bytes = msg.encode_to_vec();

        if let Some(client) = self.client.lock().await.as_ref() {
            client
                .publish(&topic, QoS::AtLeastOnce, false, bytes)
                .await
                .map_err(|e| format!("Publish failed: {}", e))?;
        } else {
            return Err("MQTT client not connected".to_string());
        }
        Ok(())
    }

    async fn publish_chat_response_proto(
        &self,
        device_id: &str,
        msg: &proto::MqttMessage,
    ) -> Result<(), String> {
        self.publish_proto_to_device(device_id, "chat/res", msg)
            .await
    }

    // ─── Incoming message handling ─────────────────────────────

    async fn handle_incoming_message(&self, topic: &str, payload: &[u8]) -> Result<(), String> {
        let parts: Vec<&str> = topic.split('/').collect();

        let msg = proto::MqttMessage::decode(payload)
            .map_err(|e| format!("Protobuf decode failed: {}", e))?;

        let device_id = parts.get(2).map(|s| s.to_string());

        let payload_type = match &msg.payload {
            Some(proto::mqtt_message::Payload::ChatRequest(_)) => "ChatRequest",
            Some(proto::mqtt_message::Payload::CollabControl(_)) => "CollabControl",
            Some(proto::mqtt_message::Payload::ChatCancel(_)) => "ChatCancel",
            Some(proto::mqtt_message::Payload::SessionSyncRequest(_)) => "SessionSyncRequest",
            Some(proto::mqtt_message::Payload::MemberSyncRequest(_)) => "MemberSyncRequest",
            Some(proto::mqtt_message::Payload::MessageSyncRequest(_)) => "MessageSyncRequest",
            Some(proto::mqtt_message::Payload::SkillSyncRequest(_)) => "SkillSyncRequest",
            Some(proto::mqtt_message::Payload::TalentSyncRequest(_)) => "TalentSyncRequest",
            Some(proto::mqtt_message::Payload::AutomationSyncRequest(_)) => "AutomationSyncRequest",
            _ => "Other",
        };
        eprintln!("[MQTT Relay] Received {} on topic {}", payload_type, topic);

        match msg.payload {
            Some(proto::mqtt_message::Payload::PairingRequest(ref req)) => {
                match self
                    .handle_pairing_request(&req.device_id, &req.device_name)
                    .await
                {
                    Ok(device) => {
                        eprintln!(
                            "[MQTT Relay] Paired with device: {} ({})",
                            device.device_name, device.device_id
                        );
                        // Persist updated config (with new paired device) to disk
                        self.persist_config().await;
                    }
                    Err(e) => {
                        eprintln!("[MQTT Relay] Pairing failed: {}", e);
                    }
                }
            }
            Some(proto::mqtt_message::Payload::ChatRequest(ref req)) => {
                let parts: Vec<&str> = topic.split('/').collect();
                if parts.len() >= 4 && parts[2] == "session" {
                    self.handle_collab_chat_request(parts[3], req).await?;
                } else {
                    self.handle_chat_request(topic, req).await?;
                }
            }
            Some(proto::mqtt_message::Payload::CollabControl(ref ctrl)) => {
                self.handle_collab_control(topic, ctrl).await?;
            }
            Some(proto::mqtt_message::Payload::ChatCancel(ref cancel)) => {
                self.handle_chat_cancel(&cancel.session_id).await;
            }
            Some(proto::mqtt_message::Payload::SessionSyncRequest(ref req)) => {
                if let Some(did) = device_id {
                    self.handle_session_list_request(&did, req).await?;
                }
            }
            Some(proto::mqtt_message::Payload::MemberSyncRequest(ref req)) => {
                if let Some(did) = device_id {
                    self.handle_member_sync_request(&did, req).await?;
                }
            }
            Some(proto::mqtt_message::Payload::SkillSyncRequest(ref req)) => {
                if let Some(did) = device_id {
                    self.handle_skill_sync_request(&did, req).await?;
                }
            }
            Some(proto::mqtt_message::Payload::TalentSyncRequest(ref req)) => {
                if let Some(did) = device_id {
                    self.handle_talent_sync_request(&did, req).await?;
                }
            }
            Some(proto::mqtt_message::Payload::AutomationSyncRequest(ref req)) => {
                if let Some(did) = device_id {
                    self.handle_automation_sync_request(&did, req).await?;
                }
            }
            Some(proto::mqtt_message::Payload::MessageSyncRequest(ref req)) => {
                let parts: Vec<&str> = topic.split('/').collect();
                if parts.len() >= 4 && parts[2] == "session" {
                    self.handle_collab_message_sync(parts[3], req).await?;
                } else if let Some(did) = device_id {
                    self.handle_message_sync_request(&did, req).await?;
                }
            }
            Some(proto::mqtt_message::Payload::SessionArchiveRequest(ref req)) => {
                if let Some(did) = device_id {
                    self.handle_session_archive_request(&did, req).await?;
                }
            }
            _ => {
                eprintln!("[MQTT Relay] Unknown or empty payload");
            }
        }
        Ok(())
    }

    /// Forward a mobile chat request to OpenCode and stream response back
    async fn handle_chat_request(
        &self,
        source_topic: &str,
        request: &proto::ChatRequest,
    ) -> Result<(), String> {
        let parts: Vec<&str> = source_topic.split('/').collect();
        let device_id = parts.get(2).ok_or("Invalid topic format")?.to_string();

        let port = self.opencode_port;
        let mobile_session_id = request.session_id.clone();

        // Use opencode_session_id from request if provided, otherwise resolve or create
        let session_id = if let Some(ref oc_id) = request.opencode_session_id {
            if !oc_id.is_empty() {
                oc_id.clone()
            } else {
                self.resolve_or_create_opencode_session(port, &mobile_session_id)
                    .await?
            }
        } else {
            self.resolve_or_create_opencode_session(port, &mobile_session_id)
                .await?
        };

        let mut prompt_parts = vec![serde_json::json!({
            "type": "text",
            "text": &request.content
        })];

        if let Some(ref image_url) = request.image_url {
            if !image_url.is_empty() {
                prompt_parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": image_url }
                }));
            }
        }

        let sse_url = format!("http://127.0.0.1:{}/event", port);
        let prompt_url = format!(
            "http://127.0.0.1:{}/session/{}/prompt_async",
            port, session_id
        );

        let http_client = reqwest::Client::new();

        let sse_response = http_client
            .get(&sse_url)
            .header("Accept", "text/event-stream")
            .timeout(Duration::from_secs(900))
            .send()
            .await
            .map_err(|e| format!("SSE connect failed: {}", e))?;

        let body = serde_json::json!({ "parts": prompt_parts });
        let prompt_resp = http_client
            .post(&prompt_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Prompt send failed: {}", e))?;
        let prompt_status = prompt_resp.status();
        if !prompt_status.is_success() {
            let resp_text = prompt_resp.text().await.unwrap_or_default();
            eprintln!("[MQTT Relay] prompt_async failed: status={} body={}", prompt_status, &resp_text[..resp_text.len().min(200)]);
            return Err(format!("prompt_async failed: {}", prompt_status));
        }
        eprintln!("[MQTT Relay] prompt_async OK for session {}", session_id);

        // Create cancel token for this stream (keyed by mobile session ID for cancel lookups)
        let cancel_token = tokio_util::sync::CancellationToken::new();
        self.cancel_tokens
            .lock()
            .await
            .insert(mobile_session_id.clone(), cancel_token.clone());

        let relay = self.clone();
        // mobile_session_id for MQTT responses, opencode session_id for SSE event filtering
        let mqtt_sid = mobile_session_id.clone();
        let sse_sid = session_id.clone();
        tokio::spawn(async move {
            if let Err(e) = relay
                .stream_sse_to_mqtt(sse_response, &device_id, &mqtt_sid, &sse_sid, &cancel_token)
                .await
            {
                eprintln!("[MQTT Relay] SSE streaming error: {}", e);
            }
            relay.cancel_tokens.lock().await.remove(&mqtt_sid);
        });

        Ok(())
    }

    async fn handle_chat_cancel(&self, session_id: &str) {
        eprintln!(
            "[MQTT Relay] Chat cancel requested for session: {}",
            session_id
        );

        // Cancel the local SSE stream (keyed by mobile session ID)
        if let Some(token) = self.cancel_tokens.lock().await.remove(session_id) {
            token.cancel();
        }

        // Resolve collab session mapping for the OpenCode abort call
        let opencode_session_id = {
            let collab_map = self.collab_sessions.lock().await;
            collab_map
                .get(session_id)
                .cloned()
                .unwrap_or_else(|| session_id.to_string())
        };

        // Also call OpenCode abort API
        let port = self.opencode_port;
        let url = format!(
            "http://127.0.0.1:{}/session/{}/abort",
            port, opencode_session_id
        );
        let _ = reqwest::Client::new().post(&url).send().await;
    }

    /// Read SSE stream, aggregate tokens every 200ms, publish to MQTT
    async fn stream_sse_to_mqtt(
        &self,
        sse_response: reqwest::Response,
        device_id: &str,
        session_id: &str,
        sse_session_id: &str,
        cancel_token: &tokio_util::sync::CancellationToken,
    ) -> Result<(), String> {
        let mut stream = sse_response.bytes_stream();
        let mut buffer = String::new();
        let mut full_content = String::new();
        let mut seq: i32 = 0;
        let mut last_flush = tokio::time::Instant::now();
        let flush_interval = Duration::from_millis(200);
        let mut pending_delta = String::new();
        let mut sent_thinking = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(900);

        loop {
            tokio::select! {
                _ = cancel_token.cancelled() => {
                    let msg = build_chat_done(session_id, seq, Some(sse_session_id));
                    self.publish_chat_response_proto(device_id, &msg).await?;
                    eprintln!("[MQTT Relay] Stream cancelled for session: {}", session_id);
                    break;
                }
                _ = tokio::time::sleep_until(deadline) => {
                    let msg = build_chat_done(session_id, seq, Some(sse_session_id));
                    self.publish_chat_response_proto(device_id, &msg).await?;
                    break;
                }
                _ = tokio::time::sleep(flush_interval), if !pending_delta.is_empty() => {
                    let msg = build_chat_delta(session_id, seq, &pending_delta);
                    self.publish_chat_response_proto(device_id, &msg).await?;
                    full_content.push_str(&pending_delta);
                    pending_delta.clear();
                    seq += 1;
                    last_flush = tokio::time::Instant::now();
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            buffer.push_str(&String::from_utf8_lossy(&bytes));

                            while let Some(pos) = buffer.find("\n\n") {
                                let event_block = buffer[..pos].to_string();
                                buffer = buffer[pos + 2..].to_string();

                                // OpenCode SSE: no `event:` line, all data in `data:` as JSON
                                // Format: data: {"type": "message.part.delta", "properties": {...}}
                                let mut data = String::new();
                                for line in event_block.lines() {
                                    if let Some(d) = line.strip_prefix("data: ") {
                                        data = d.to_string();
                                    }
                                }

                                if data.is_empty() { continue; }

                                let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else { continue };
                                let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                let props = v.get("properties");

                                // Track part types to distinguish thinking text from real reply
                                if event_type == "message.part.updated" {
                                    if let Some(part) = props.and_then(|p| p.get("part")) {
                                        let pt = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                        if pt == "reasoning" || pt == "thinking" {
                                            if !sent_thinking {
                                                sent_thinking = true;
                                                let msg = build_chat_has_thinking(session_id, seq);
                                                self.publish_chat_response_proto(device_id, &msg).await?;
                                                seq += 1;
                                            }
                                        }
                                    }
                                }

                                // Filter: only process events for our session (match against OpenCode session ID)
                                let event_sid = props
                                    .and_then(|p| p.get("sessionID").and_then(|s| s.as_str()))
                                    .or_else(|| props.and_then(|p| p.get("info").and_then(|i| i.get("sessionID").and_then(|s| s.as_str()))));
                                if let Some(sid) = event_sid {
                                    if sid != sse_session_id { continue; }
                                }

                                match event_type {
                                    "message.part.delta" => {
                                        let field = props
                                            .and_then(|p| p.get("field").and_then(|f| f.as_str()))
                                            .unwrap_or("text");
                                        if field == "text" {
                                            if let Some(text) = props.and_then(|p| p.get("delta").and_then(|d| d.as_str())) {
                                                if seq == 0 && pending_delta.is_empty() {
                                                    eprintln!("[MQTT Relay] First text delta: {:?}", &text[..text.len().min(50)]);
                                                }
                                                pending_delta.push_str(text);
                                                if last_flush.elapsed() >= flush_interval && !pending_delta.is_empty() {
                                                    let msg = build_chat_delta(session_id, seq, &pending_delta);
                                                    self.publish_chat_response_proto(device_id, &msg).await?;
                                                    full_content.push_str(&pending_delta);
                                                    pending_delta.clear();
                                                    seq += 1;
                                                    last_flush = tokio::time::Instant::now();
                                                }
                                            }
                                        }
                                        // field == "reasoning" or pre-reasoning text → skip
                                    }
                                    "message.part.updated" => {
                                        let part = props.and_then(|p| p.get("part"));
                                        let part_type = part
                                            .and_then(|p| p.get("type").and_then(|t| t.as_str()))
                                            .unwrap_or("");

                                        match part_type {
                                            "tool" | "tool-call" | "tool-result" => {
                                                // Flush any pending text delta first
                                                if !pending_delta.is_empty() {
                                                    let msg = build_chat_delta(session_id, seq, &pending_delta);
                                                    self.publish_chat_response_proto(device_id, &msg).await?;
                                                    full_content.push_str(&pending_delta);
                                                    pending_delta.clear();
                                                    seq += 1;
                                                    last_flush = tokio::time::Instant::now();
                                                }

                                                let tool_name = part
                                                    .and_then(|p| p.get("tool").and_then(|t| t.as_str()))
                                                    .or_else(|| part.and_then(|p| p.get("toolName").and_then(|t| t.as_str())))
                                                    .unwrap_or("unknown");
                                                let tool_call_id = part
                                                    .and_then(|p| p.get("callID").and_then(|t| t.as_str()))
                                                    .or_else(|| part.and_then(|p| p.get("toolCallId").and_then(|t| t.as_str())))
                                                    .or_else(|| part.and_then(|p| p.get("id").and_then(|t| t.as_str())))
                                                    .unwrap_or("");
                                                // Skip tool events without an ID (initial stub before details arrive)
                                                if tool_call_id.is_empty() { continue; }
                                                let state = part.and_then(|p| p.get("state"));
                                                let status_raw = state
                                                    .and_then(|s| s.get("status"))
                                                    .and_then(|s| s.as_str())
                                                    .unwrap_or("");
                                                let time = props.and_then(|p| p.get("time"));
                                                let has_ended = time
                                                    .and_then(|t| t.get("end"))
                                                    .is_some();

                                                let status = match status_raw {
                                                    "completed" | "done" | "success" => "completed",
                                                    "error" | "failed" => "failed",
                                                    _ if has_ended => "completed",
                                                    _ => "running",
                                                };

                                                let arguments_json = state
                                                    .and_then(|s| s.get("input"))
                                                    .map(|input| serde_json::to_string(input).unwrap_or_default())
                                                    .unwrap_or_default();
                                                let result_summary = state
                                                    .and_then(|s| s.get("output").or_else(|| s.get("raw")).or_else(|| s.get("result")))
                                                    .map(|r| {
                                                        if let Some(s) = r.as_str() { s.to_string() }
                                                        else { serde_json::to_string(r).unwrap_or_default() }
                                                    })
                                                    .unwrap_or_default();
                                                let duration_ms = time
                                                    .and_then(|t| {
                                                        let start = t.get("start")?.as_f64()?;
                                                        let end = t.get("end")?.as_f64()?;
                                                        Some(((end - start) * 1000.0) as i32)
                                                    })
                                                    .unwrap_or(0);

                                                let msg = build_chat_tool_event(
                                                    session_id, seq,
                                                    tool_call_id, tool_name, status,
                                                    &arguments_json, &result_summary, duration_ms,
                                                );
                                                self.publish_chat_response_proto(device_id, &msg).await?;
                                                seq += 1;
                                            }
                                            _ => {}
                                        }
                                    }
                                    "message.completed" => {
                                        // Flush pending delta but don't end stream — more messages
                                        // may follow (e.g. tool calls then final reply)
                                        if !pending_delta.is_empty() {
                                            let msg = build_chat_delta(session_id, seq, &pending_delta);
                                            self.publish_chat_response_proto(device_id, &msg).await?;
                                            full_content.push_str(&pending_delta);
                                            pending_delta.clear();
                                            seq += 1;
                                            last_flush = tokio::time::Instant::now();
                                        }
                                    }
                                    "session.idle" => {
                                        eprintln!("[MQTT Relay] session.idle: seq={} pending={}bytes full={}bytes", seq, pending_delta.len(), full_content.len());
                                        if !pending_delta.is_empty() {
                                            let msg = build_chat_delta(session_id, seq, &pending_delta);
                                            self.publish_chat_response_proto(device_id, &msg).await?;
                                            seq += 1;
                                            pending_delta.clear();
                                        }
                                        let msg = build_chat_done(session_id, seq, Some(sse_session_id));
                                        self.publish_chat_response_proto(device_id, &msg).await?;
                                        return Ok(());
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Some(Err(e)) => {
                            let msg = build_chat_error(session_id, seq, &format!("SSE stream error: {}", e));
                            let _ = self.publish_chat_response_proto(device_id, &msg).await;
                            return Err(format!("SSE stream error: {}", e));
                        }
                        None => {
                            if !pending_delta.is_empty() {
                                let msg = build_chat_delta(session_id, seq, &pending_delta);
                                self.publish_chat_response_proto(device_id, &msg).await?;
                                seq += 1;
                            }
                            let msg = build_chat_done(session_id, seq, Some(sse_session_id));
                            self.publish_chat_response_proto(device_id, &msg).await?;
                            break;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    // ─── Session List ──────────────────────────────────────────

    async fn handle_session_list_request(
        &self,
        device_id: &str,
        req: &proto::SessionSyncRequest,
    ) -> Result<(), String> {
        let port = self.opencode_port;
        match super::opencode_list_sessions(port).await {
            Ok(mut sessions) => {
                let after = req.after_updated;
                if after > 0 {
                    // Incremental mode: return sessions updated after the given timestamp (including archived ones)
                    let after_ms = after * 1000;
                    sessions.retain(|s| s.updated > after_ms);
                } else {
                    // Full mode: filter out archived, truncate
                    sessions.retain(|s| !s.archived);
                    sessions.truncate(super::MAX_SESSIONS_LIST);
                }
                eprintln!(
                    "[MQTT Relay] Sending {} session(s) to device {} (after_updated={})",
                    sessions.len(),
                    &device_id[..device_id.len().min(8)],
                    after
                );
                let session_data: Vec<proto::SessionData> = sessions
                    .iter()
                    .map(|s| proto::SessionData {
                        id: s.id.clone(),
                        title: s.title.clone(),
                        updated: s.updated / 1000,
                        is_archived: s.archived,
                    })
                    .collect();
                let msg = build_envelope(proto::mqtt_message::Payload::SessionSyncResponse(
                    proto::SessionSyncResponse {
                        sessions: session_data.clone(),
                        pagination: Some(proto::PageInfo {
                            page: 1,
                            page_size: 50,
                            total: session_data.len() as i32,
                        }),
                    },
                ));
                self.publish_proto_to_device(device_id, "chat/res", &msg)
                    .await?;
            }
            Err(e) => {
                eprintln!("[MQTT Relay] Failed to fetch sessions: {}", e);
            }
        }
        Ok(())
    }

    // ─── Session Archive ──────────────────────────────────────

    async fn handle_session_archive_request(
        &self,
        device_id: &str,
        req: &proto::SessionArchiveRequest,
    ) -> Result<(), String> {
        let port = self.opencode_port;
        let mut errors: Vec<String> = vec![];

        for session_id in &req.session_ids {
            if let Err(e) = super::opencode_archive_session(port, session_id).await {
                eprintln!(
                    "[MQTT Relay] Failed to archive session {}: {}",
                    session_id, e
                );
                errors.push(format!("{}: {}", session_id, e));
            }
        }

        let (success, error) = if errors.is_empty() {
            (true, String::new())
        } else {
            (false, errors.join("; "))
        };

        let msg = build_envelope(proto::mqtt_message::Payload::SessionArchiveResponse(
            proto::SessionArchiveResponse { success, error },
        ));
        self.publish_proto_to_device(device_id, "chat/res", &msg)
            .await
    }

    // ─── Member Sync ───────────────────────────────────────────

    async fn handle_member_sync_request(
        &self,
        device_id: &str,
        _req: &proto::MemberSyncRequest,
    ) -> Result<(), String> {
        let manifest = self.fetch_team_manifest()?;

        // Human members from manifest (filter out Seed nodes)
        let mut members: Vec<proto::MemberData> = match manifest {
            Some(m) => m
                .members
                .into_iter()
                .filter(|tm| tm.role != MemberRole::Seed)
                .map(|tm| proto::MemberData {
                    id: tm.node_id,
                    name: if tm.name.is_empty() {
                        tm.hostname.clone()
                    } else {
                        tm.name
                    },
                    avatar_url: String::new(),
                    department: if tm.label.is_empty() {
                        None
                    } else {
                        Some(tm.label)
                    },
                    is_ai_ally: false,
                    note: format!("{}/{} ({:?})", tm.platform, tm.arch, tm.role),
                })
                .collect(),
            None => vec![],
        };

        // AI allies from .opencode/roles/
        let roles_dir = std::path::Path::new(&self.workspace_path)
            .join(".opencode")
            .join("roles");
        if roles_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&roles_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let slug = entry.file_name().to_string_lossy().to_string();
                    if slug == "skill" || slug == "config.json" {
                        continue;
                    }

                    let role_md = path.join("ROLE.md");
                    if !role_md.exists() {
                        continue;
                    }

                    if let Ok(content) = std::fs::read_to_string(&role_md) {
                        let parsed = parse_role_md(&content);
                        let name = if parsed.name.is_empty() {
                            slug.clone()
                        } else {
                            parsed.name
                        };
                        members.push(proto::MemberData {
                            id: slug,
                            name,
                            avatar_url: String::new(),
                            department: Some("Role".to_string()),
                            is_ai_ally: true,
                            note: parsed.description,
                        });
                    }
                }
            }
        }

        let total = members.len() as i32;
        let msg = build_envelope(proto::mqtt_message::Payload::MemberSyncResponse(
            proto::MemberSyncResponse {
                members,
                pagination: Some(proto::PageInfo {
                    page: 1,
                    page_size: 50,
                    total,
                }),
            },
        ));
        self.publish_proto_to_device(device_id, "member", &msg)
            .await
    }

    /// Fetch TeamManifest from local files only (P2P or OSS cache). No S3 calls.
    fn fetch_team_manifest(&self) -> Result<Option<TeamManifest>, String> {
        // Try P2P local file
        let p2p_path = format!("{}/teamclaw-team/_team/members.json", self.workspace_path);
        if let Ok(content) = std::fs::read_to_string(&p2p_path) {
            if let Ok(manifest) = serde_json::from_str::<TeamManifest>(&content) {
                return Ok(Some(manifest));
            }
        }

        // Try OSS local cache (written by slow loop)
        let oss_cache_path = format!("{}/.teamclaw/_team/members.json", self.workspace_path);
        if let Ok(content) = std::fs::read_to_string(&oss_cache_path) {
            if let Ok(manifest) = serde_json::from_str::<TeamManifest>(&content) {
                return Ok(Some(manifest));
            }
        }

        Ok(None)
    }

    // ─── Skill Sync ─────────────────────────────────────────────

    async fn handle_skill_sync_request(
        &self,
        device_id: &str,
        _req: &proto::SkillSyncRequest,
    ) -> Result<(), String> {
        // Read installed skills from clawhub lockfile
        let lockfile_path = std::path::Path::new(&self.workspace_path)
            .join(".clawhub")
            .join("lock.json");

        let skills: Vec<proto::SkillData> =
            if let Ok(content) = std::fs::read_to_string(&lockfile_path) {
                if let Ok(lock) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(skills_map) = lock.get("skills").and_then(|s| s.as_object()) {
                        skills_map
                            .iter()
                            .map(|(slug, entry)| {
                                let version =
                                    entry.get("version").and_then(|v| v.as_str()).unwrap_or("");
                                proto::SkillData {
                                    id: slug.clone(),
                                    name: slug.clone(),
                                    description: format!("v{}", version),
                                    is_personal: false,
                                    is_enabled: true,
                                }
                            })
                            .collect()
                    } else {
                        vec![]
                    }
                } else {
                    vec![]
                }
            } else {
                vec![]
            };

        let total = skills.len() as i32;
        let msg = build_envelope(proto::mqtt_message::Payload::SkillSyncResponse(
            proto::SkillSyncResponse {
                skills,
                pagination: Some(proto::PageInfo {
                    page: 1,
                    page_size: 50,
                    total,
                }),
            },
        ));
        self.publish_proto_to_device(device_id, "skill", &msg).await
    }

    // ─── Talent Sync (roles from .opencode/roles/) ─────────────────

    async fn handle_talent_sync_request(
        &self,
        device_id: &str,
        _req: &proto::TalentSyncRequest,
    ) -> Result<(), String> {
        let roles_dir = std::path::Path::new(&self.workspace_path)
            .join(".opencode")
            .join("roles");

        let mut talents: Vec<proto::TalentData> = vec![];

        if roles_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&roles_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let slug = entry.file_name().to_string_lossy().to_string();
                    if slug == "skill" || slug == "config.json" {
                        continue;
                    }

                    let role_md = path.join("ROLE.md");
                    if !role_md.exists() {
                        continue;
                    }

                    if let Ok(content) = std::fs::read_to_string(&role_md) {
                        let parsed = parse_role_md(&content);
                        let skill_count = parsed.role_skills.len() as i32;
                        talents.push(proto::TalentData {
                            id: slug.clone(),
                            name: if parsed.name.is_empty() {
                                slug
                            } else {
                                parsed.name
                            },
                            description: parsed.description,
                            category: "Role".to_string(),
                            icon: Some("cpu".to_string()),
                            downloads: skill_count,
                            role: parsed.role,
                            when_to_use: parsed.when_to_use,
                            working_style: parsed.working_style,
                            role_skills: parsed.role_skills,
                        });
                    }
                }
            }
        }

        let total = talents.len() as i32;
        let msg = build_envelope(proto::mqtt_message::Payload::TalentSyncResponse(
            proto::TalentSyncResponse {
                talents,
                pagination: Some(proto::PageInfo {
                    page: 1,
                    page_size: 50,
                    total,
                }),
            },
        ));
        self.publish_proto_to_device(device_id, "talent", &msg)
            .await
    }

    // ─── Automation Sync ──────────────────────────────────────────

    async fn handle_automation_sync_request(
        &self,
        device_id: &str,
        _req: &proto::AutomationSyncRequest,
    ) -> Result<(), String> {
        // Read cron jobs from local storage
        let cron_path = std::path::Path::new(&self.workspace_path)
            .join(".teamclaw")
            .join("cron-jobs.json");

        let tasks: Vec<proto::AutomationTaskData> =
            if let Ok(content) = std::fs::read_to_string(&cron_path) {
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(jobs) = data.get("jobs").and_then(|j| j.as_array()) {
                        jobs.iter()
                            .filter_map(|job| {
                                let id = job.get("id")?.as_str()?;
                                let name = job.get("name")?.as_str()?;
                                let enabled = job
                                    .get("enabled")
                                    .and_then(|e| e.as_bool())
                                    .unwrap_or(false);
                                let cron_expr = job
                                    .get("schedule")
                                    .and_then(|s| s.get("expr"))
                                    .and_then(|e| e.as_str())
                                    .unwrap_or("");
                                let description = job
                                    .get("description")
                                    .and_then(|d| d.as_str())
                                    .unwrap_or("");
                                let last_run = job
                                    .get("lastRunAt")
                                    .and_then(|t| t.as_str())
                                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                                    .map(|dt| dt.timestamp() as f64);
                                let status = if enabled { "idle" } else { "disabled" };

                                Some(proto::AutomationTaskData {
                                    id: id.to_string(),
                                    name: name.to_string(),
                                    status: Some(status.to_string()),
                                    cron_expression: cron_expr.to_string(),
                                    description: description.to_string(),
                                    last_run_time: last_run,
                                })
                            })
                            .collect()
                    } else {
                        vec![]
                    }
                } else {
                    vec![]
                }
            } else {
                vec![]
            };

        let total = tasks.len() as i32;
        let msg = build_envelope(proto::mqtt_message::Payload::AutomationSyncResponse(
            proto::AutomationSyncResponse {
                tasks,
                pagination: Some(proto::PageInfo {
                    page: 1,
                    page_size: 50,
                    total,
                }),
            },
        ));
        self.publish_proto_to_device(device_id, "task", &msg).await
    }

    // ─── Message History Sync ──────────────────────────────────

    async fn handle_message_sync_request(
        &self,
        device_id: &str,
        req: &proto::MessageSyncRequest,
    ) -> Result<(), String> {
        let port = self.opencode_port;
        let mobile_session_id = &req.session_id;
        // Use opencode_session_id from request if provided, otherwise resolve from map
        let session_id = if let Some(ref oc_id) = req.opencode_session_id {
            if !oc_id.is_empty() { oc_id.clone() } else { mobile_session_id.clone() }
        } else {
            let collab_map = self.collab_sessions.lock().await;
            collab_map
                .get(mobile_session_id)
                .cloned()
                .unwrap_or_else(|| mobile_session_id.clone())
        };
        let url = format!("http://127.0.0.1:{}/session/{}/message", port, session_id);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch messages: {}", e))?;

        let raw_messages: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse messages: {}", e))?;

        let messages: Vec<proto::ChatMessageData> = raw_messages
            .iter()
            .filter_map(|msg| {
                let info = msg.get("info")?;
                let id = info.get("id")?.as_str()?;
                let role = info.get("role")?.as_str()?;
                if role != "user" && role != "assistant" {
                    return None;
                }

                let parts_array = msg.get("parts")?.as_array()?;
                let mut message_parts: Vec<proto::MessagePartData> = Vec::new();
                let mut content_parts: Vec<String> = Vec::new();
                let mut has_thinking = false;

                for part in parts_array {
                    match part.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                                content_parts.push(text.to_string());
                                message_parts.push(proto::MessagePartData {
                                    r#type: "text".to_string(),
                                    text: Some(text.to_string()),
                                    tool: None,
                                });
                            }
                        }
                        Some("tool") | Some("tool-call") => {
                            let tool_name =
                                part.get("tool").and_then(|t| t.as_str()).unwrap_or("tool");
                            let tool_call_id = part
                                .get("callID")
                                .or_else(|| part.get("id"))
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string();
                            let state = part.get("state");
                            let status_raw = state
                                .and_then(|s| s.get("status"))
                                .and_then(|s| s.as_str())
                                .unwrap_or("completed");
                            let has_ended = part.get("time").and_then(|t| t.get("end")).is_some();
                            let status = match status_raw {
                                "completed" | "done" | "success" => "completed",
                                "error" | "failed" => "failed",
                                _ if has_ended => "completed",
                                _ => "running",
                            };
                            let arguments_json = state
                                .and_then(|s| s.get("input"))
                                .map(|input| serde_json::to_string(input).unwrap_or_default())
                                .unwrap_or_default();
                            let result_summary = state
                                .and_then(|s| {
                                    s.get("output")
                                        .or_else(|| s.get("raw"))
                                        .or_else(|| s.get("result"))
                                })
                                .map(|r| {
                                    if let Some(s) = r.as_str() {
                                        s.to_string()
                                    } else {
                                        serde_json::to_string(r).unwrap_or_default()
                                    }
                                })
                                .unwrap_or_default();
                            let duration_ms = part
                                .get("time")
                                .and_then(|t| {
                                    let start = t.get("start")?.as_f64()?;
                                    let end = t.get("end")?.as_f64()?;
                                    Some(((end - start) * 1000.0) as i32)
                                })
                                .unwrap_or(0);

                            // Backward-compat content summary
                            let input_summary = state
                                .and_then(|s| s.get("input"))
                                .map(|input| {
                                    if let Some(q) = input.get("query").and_then(|v| v.as_str()) {
                                        q.to_string()
                                    } else if let Some(u) =
                                        input.get("url").and_then(|v| v.as_str())
                                    {
                                        u.to_string()
                                    } else if let Some(p) =
                                        input.get("path").and_then(|v| v.as_str())
                                    {
                                        p.to_string()
                                    } else if let Some(c) =
                                        input.get("command").and_then(|v| v.as_str())
                                    {
                                        c.to_string()
                                    } else {
                                        serde_json::to_string(input)
                                            .unwrap_or_default()
                                            .chars()
                                            .take(80)
                                            .collect()
                                    }
                                })
                                .unwrap_or_default();
                            content_parts.push(format!("🔧 {} {}", tool_name, input_summary));

                            message_parts.push(proto::MessagePartData {
                                r#type: "tool".to_string(),
                                text: None,
                                tool: Some(proto::ToolEvent {
                                    tool_call_id,
                                    tool_name: tool_name.to_string(),
                                    status: status.to_string(),
                                    arguments_json: truncate_string(&arguments_json, 500),
                                    result_summary: truncate_string(&result_summary, 1000),
                                    duration_ms,
                                }),
                            });
                        }
                        Some("thinking") | Some("reasoning") => {
                            has_thinking = true;
                        }
                        _ => {}
                    }
                }
                let content = content_parts.join("\n");
                if content.trim().is_empty() && message_parts.is_empty() {
                    return None;
                }

                let timestamp_ms = info
                    .get("time")
                    .and_then(|t| t.get("created"))
                    .and_then(|t| t.as_f64())
                    .unwrap_or(0.0);
                let timestamp = timestamp_ms / 1000.0;

                Some(proto::ChatMessageData {
                    id: id.to_string(),
                    role: role.to_string(),
                    content,
                    timestamp,
                    image_url: None,
                    parts: message_parts,
                    has_thinking,
                    sender_id: None,
                    sender_name: None,
                })
            })
            .collect();

        let msg = build_envelope(proto::mqtt_message::Payload::MessageSyncResponse(
            proto::MessageSyncResponse {
                session_id: mobile_session_id.clone(),
                messages,
            },
        ));
        self.publish_proto_to_device(device_id, "chat/res", &msg)
            .await
    }

    /// Handle message history sync for a collab session.
    /// Looks up the OpenCode session_id from `collab_sessions`, fetches messages,
    /// enriches each message with sender_id/sender_name from `[Name] content` prefix,
    /// and publishes the response to the session topic.
    async fn handle_collab_message_sync(
        &self,
        collab_session_id: &str,
        _req: &proto::MessageSyncRequest,
    ) -> Result<(), String> {
        // Look up OpenCode session_id for this collab session
        let opencode_session_id = {
            let sessions = self.collab_sessions.lock().await;
            sessions
                .get(collab_session_id)
                .cloned()
                .ok_or_else(|| format!("Collab session not found: {}", collab_session_id))?
        };

        let port = self.opencode_port;
        let url = format!(
            "http://127.0.0.1:{}/session/{}/message",
            port, opencode_session_id
        );

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch collab messages: {}", e))?;

        let raw_messages: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse collab messages: {}", e))?;

        let messages: Vec<proto::ChatMessageData> = raw_messages
            .iter()
            .filter_map(|msg| {
                let info = msg.get("info")?;
                let id = info.get("id")?.as_str()?;
                let role = info.get("role")?.as_str()?;
                if role != "user" && role != "assistant" {
                    return None;
                }

                let parts_array = msg.get("parts")?.as_array()?;
                let mut message_parts: Vec<proto::MessagePartData> = Vec::new();
                let mut content_parts: Vec<String> = Vec::new();
                let mut has_thinking = false;

                for part in parts_array {
                    match part.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                                content_parts.push(text.to_string());
                                message_parts.push(proto::MessagePartData {
                                    r#type: "text".to_string(),
                                    text: Some(text.to_string()),
                                    tool: None,
                                });
                            }
                        }
                        Some("tool") | Some("tool-call") => {
                            let tool_name =
                                part.get("tool").and_then(|t| t.as_str()).unwrap_or("tool");
                            let tool_call_id = part
                                .get("callID")
                                .or_else(|| part.get("id"))
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string();
                            let state = part.get("state");
                            let status_raw = state
                                .and_then(|s| s.get("status"))
                                .and_then(|s| s.as_str())
                                .unwrap_or("completed");
                            let has_ended =
                                part.get("time").and_then(|t| t.get("end")).is_some();
                            let status = match status_raw {
                                "completed" | "done" | "success" => "completed",
                                "error" | "failed" => "failed",
                                _ if has_ended => "completed",
                                _ => "running",
                            };
                            let arguments_json = state
                                .and_then(|s| s.get("input"))
                                .map(|input| serde_json::to_string(input).unwrap_or_default())
                                .unwrap_or_default();
                            let result_summary = state
                                .and_then(|s| {
                                    s.get("output")
                                        .or_else(|| s.get("raw"))
                                        .or_else(|| s.get("result"))
                                })
                                .map(|r| {
                                    if let Some(s) = r.as_str() {
                                        s.to_string()
                                    } else {
                                        serde_json::to_string(r).unwrap_or_default()
                                    }
                                })
                                .unwrap_or_default();
                            let duration_ms = part
                                .get("time")
                                .and_then(|t| {
                                    let start = t.get("start")?.as_f64()?;
                                    let end = t.get("end")?.as_f64()?;
                                    Some(((end - start) * 1000.0) as i32)
                                })
                                .unwrap_or(0);
                            let input_summary = state
                                .and_then(|s| s.get("input"))
                                .map(|input| {
                                    if let Some(q) = input.get("query").and_then(|v| v.as_str()) {
                                        q.to_string()
                                    } else if let Some(u) =
                                        input.get("url").and_then(|v| v.as_str())
                                    {
                                        u.to_string()
                                    } else if let Some(p) =
                                        input.get("path").and_then(|v| v.as_str())
                                    {
                                        p.to_string()
                                    } else if let Some(c) =
                                        input.get("command").and_then(|v| v.as_str())
                                    {
                                        c.to_string()
                                    } else {
                                        serde_json::to_string(input)
                                            .unwrap_or_default()
                                            .chars()
                                            .take(80)
                                            .collect()
                                    }
                                })
                                .unwrap_or_default();
                            content_parts.push(format!("🔧 {} {}", tool_name, input_summary));
                            message_parts.push(proto::MessagePartData {
                                r#type: "tool".to_string(),
                                text: None,
                                tool: Some(proto::ToolEvent {
                                    tool_call_id,
                                    tool_name: tool_name.to_string(),
                                    status: status.to_string(),
                                    arguments_json: truncate_string(&arguments_json, 500),
                                    result_summary: truncate_string(&result_summary, 1000),
                                    duration_ms,
                                }),
                            });
                        }
                        Some("thinking") | Some("reasoning") => {
                            has_thinking = true;
                        }
                        _ => {}
                    }
                }

                let raw_content = content_parts.join("\n");
                if raw_content.trim().is_empty() && message_parts.is_empty() {
                    return None;
                }

                let timestamp_ms = info
                    .get("time")
                    .and_then(|t| t.get("created"))
                    .and_then(|t| t.as_f64())
                    .unwrap_or(0.0);
                let timestamp = timestamp_ms / 1000.0;

                // Determine sender info based on role and optional [Name] prefix
                let (sender_id, sender_name, content) = if role == "assistant" {
                    ("agent".to_string(), "Agent".to_string(), raw_content)
                } else {
                    // Parse [Name] prefix from user messages written by collab participants
                    let (name, stripped) = if raw_content.starts_with('[') {
                        if let Some(bracket_end) = raw_content.find(']') {
                            let name = raw_content[1..bracket_end].to_string();
                            let rest = raw_content[bracket_end + 1..].trim_start().to_string();
                            (name, rest)
                        } else {
                            (String::new(), raw_content)
                        }
                    } else {
                        (String::new(), raw_content)
                    };
                    let (sid, sname) = if name.is_empty() {
                        (String::new(), String::new())
                    } else {
                        (name.to_lowercase().replace(' ', "_"), name)
                    };
                    (sid, sname, stripped)
                };

                Some(proto::ChatMessageData {
                    id: id.to_string(),
                    role: role.to_string(),
                    content,
                    timestamp,
                    image_url: None,
                    parts: message_parts,
                    has_thinking,
                    sender_id: if sender_id.is_empty() {
                        None
                    } else {
                        Some(sender_id)
                    },
                    sender_name: if sender_name.is_empty() {
                        None
                    } else {
                        Some(sender_name)
                    },
                })
            })
            .collect();

        let msg = build_envelope(proto::mqtt_message::Payload::MessageSyncResponse(
            proto::MessageSyncResponse {
                session_id: collab_session_id.to_string(),
                messages,
            },
        ));

        // Publish response to the session topic (not a device topic)
        let config = self.config.read().await;
        let topic = format!(
            "teamclaw/{}/session/{}",
            config.team_id, collab_session_id
        );
        let bytes = msg.encode_to_vec();
        if let Some(client) = self.client.lock().await.as_ref() {
            client
                .publish(&topic, QoS::AtLeastOnce, false, bytes)
                .await
                .map_err(|e| format!("Collab message sync publish failed: {}", e))?;
            eprintln!(
                "[MQTT Relay] Published collab message sync response to {}",
                topic
            );
        } else {
            return Err("MQTT client not connected".to_string());
        }
        Ok(())
    }

    // ─── Device Pairing ────────────────────────────────────────

    pub async fn generate_pairing_code(&self) -> Result<String, String> {
        use rand::Rng;
        let code: String = {
            let mut rng = rand::thread_rng();
            (0..6).map(|_| rng.gen_range(0..10).to_string()).collect()
        };

        let session = PairingSession {
            code: code.clone(),
            created_at: std::time::Instant::now(),
            expires_in: Duration::from_secs(300),
        };
        *self.pairing_session.lock().await = Some(session);

        {
            let mut config = self.config.write().await;
            if config.team_id.is_empty() {
                config.team_id = uuid::Uuid::new_v4().to_string();
            }
            if config.device_id.is_empty() {
                config.device_id = format!("desktop-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            }
        }

        if let Some(client) = self.client.lock().await.as_ref() {
            let config = self.config.read().await;
            let discover_topic = format!("teamclaw/pairing/{}", code);

            let msg = build_envelope(proto::mqtt_message::Payload::PairingDiscovery(
                proto::PairingDiscovery {
                    team_id: config.team_id.clone(),
                    device_id: config.device_id.clone(),
                    device_name: config.device_name.clone(),
                },
            ));
            client
                .publish(&discover_topic, QoS::AtLeastOnce, true, msg.encode_to_vec())
                .await
                .map_err(|e| format!("Discovery publish failed: {}", e))?;

            client
                .subscribe(&discover_topic, QoS::AtLeastOnce)
                .await
                .map_err(|e| format!("Subscribe to pairing topic failed: {}", e))?;
        }

        Ok(code)
    }

    pub async fn handle_pairing_request(
        &self,
        mobile_device_id: &str,
        mobile_device_name: &str,
    ) -> Result<PairedDevice, String> {
        let session = self
            .pairing_session
            .lock()
            .await
            .take()
            .ok_or("No active pairing session")?;

        if session.is_expired() {
            return Err("Pairing code has expired".to_string());
        }

        // Use the team's shared broker credentials so the mobile device can authenticate
        let mqtt_username = {
            let config = self.config.read().await;
            config.username.clone()
        };
        let mqtt_password = {
            let config = self.config.read().await;
            config.password.clone()
        };

        let device = PairedDevice {
            device_id: mobile_device_id.to_string(),
            device_name: mobile_device_name.to_string(),
            mqtt_username: mqtt_username.clone(),
            mqtt_password: mqtt_password.clone(),
            paired_at: now_timestamp() as u64,
        };

        {
            let mut config = self.config.write().await;
            config.paired_devices.push(device.clone());
        }

        if let Some(client) = self.client.lock().await.as_ref() {
            let config = self.config.read().await;
            let topic = format!("teamclaw/{}/{}/chat/req", config.team_id, mobile_device_id);
            client
                .subscribe(&topic, QoS::AtLeastOnce)
                .await
                .map_err(|e| format!("Subscribe failed: {}", e))?;
        }

        // Re-publish online status so the new device receives it immediately
        if let Some(client) = self.client.lock().await.as_ref() {
            let config = self.config.read().await;
            let _ = self.publish_status(client, &config, true).await;
        }

        if let Some(client) = self.client.lock().await.as_ref() {
            let config = self.config.read().await;
            let msg = build_envelope(proto::mqtt_message::Payload::PairingResponse(
                proto::PairingResponse {
                    mqtt_host: config.broker_host.clone(),
                    mqtt_port: config.broker_port as u32,
                    mqtt_username,
                    mqtt_password,
                    team_id: config.team_id.clone(),
                    desktop_device_id: config.device_id.clone(),
                    desktop_device_name: config.device_name.clone(),
                },
            ));
            let pairing_topic = format!("teamclaw/pairing/{}", session.code);
            client
                .publish(&pairing_topic, QoS::AtLeastOnce, false, msg.encode_to_vec())
                .await
                .map_err(|e| format!("Pairing response publish failed: {}", e))?;
        }

        Ok(device)
    }

    pub async fn unpair_device(&self, device_id: &str) -> Result<(), String> {
        let mut config = self.config.write().await;
        config.paired_devices.retain(|d| d.device_id != device_id);

        if let Some(client) = self.client.lock().await.as_ref() {
            let topic = format!("teamclaw/{}/{}/chat/req", config.team_id, device_id);
            let _ = client.unsubscribe(&topic).await;
        }

        Ok(())
    }

    /// Persist current in-memory MQTT config (including paired devices) to disk.
    async fn persist_config(&self) {
        let config = self.config.read().await.clone();
        let workspace_path = self.workspace_path.clone();
        match super::read_config(&workspace_path) {
            Ok(mut full_config) => {
                let mut channels = full_config.channels.unwrap_or_default();
                channels.mqtt = Some(config);
                full_config.channels = Some(channels);
                if let Err(e) = super::write_config(&workspace_path, &full_config) {
                    eprintln!("[MQTT Relay] Failed to persist config: {}", e);
                }
            }
            Err(e) => eprintln!("[MQTT Relay] Failed to read config for persistence: {}", e),
        }
    }

    // ─── Data Sync ─────────────────────────────────────────────

    pub async fn sync_tasks(
        &self,
        device_id: &str,
        tasks: Vec<proto::AutomationTaskData>,
    ) -> Result<(), String> {
        let msg = build_envelope(proto::mqtt_message::Payload::AutomationSyncResponse(
            proto::AutomationSyncResponse {
                tasks,
                pagination: Some(proto::PageInfo {
                    page: 1,
                    page_size: 50,
                    total: 0,
                }),
            },
        ));
        self.publish_proto_to_device(device_id, "task", &msg).await
    }

    pub async fn sync_skills(
        &self,
        device_id: &str,
        skills: Vec<proto::SkillData>,
    ) -> Result<(), String> {
        let msg = build_envelope(proto::mqtt_message::Payload::SkillSyncResponse(
            proto::SkillSyncResponse {
                skills,
                pagination: Some(proto::PageInfo {
                    page: 1,
                    page_size: 50,
                    total: 0,
                }),
            },
        ));
        self.publish_proto_to_device(device_id, "skill", &msg).await
    }

    pub async fn sync_members(
        &self,
        device_id: &str,
        members: Vec<proto::MemberData>,
    ) -> Result<(), String> {
        let msg = build_envelope(proto::mqtt_message::Payload::MemberSyncResponse(
            proto::MemberSyncResponse {
                members,
                pagination: Some(proto::PageInfo {
                    page: 1,
                    page_size: 50,
                    total: 0,
                }),
            },
        ));
        self.publish_proto_to_device(device_id, "member", &msg)
            .await
    }

    // ─── Collab Session Control ────────────────────────────────

    async fn handle_collab_control(
        &self,
        _topic: &str,
        ctrl: &proto::CollabControl,
    ) -> Result<(), String> {
        use proto::CollabControlType;
        let ctrl_type = ctrl.r#type();
        let collab_session_id = match &ctrl.session_id {
            Some(id) => id.clone(),
            None => {
                eprintln!("[MQTT Relay] CollabControl missing session_id");
                return Ok(());
            }
        };

        match ctrl_type {
            CollabControlType::CollabCreate => {
                eprintln!(
                    "[MQTT Relay] CollabCreate for session {}",
                    collab_session_id
                );
                let opencode_session_id =
                    teamclaw_gateway::create_opencode_session(self.opencode_port).await?;
                eprintln!(
                    "[MQTT Relay] Created OpenCode session {} for collab session {}",
                    opencode_session_id, collab_session_id
                );
                self.collab_sessions
                    .lock()
                    .await
                    .insert(collab_session_id.clone(), opencode_session_id);

                let config = self.config.read().await;
                let topic =
                    format!("teamclaw/{}/session/{}", config.team_id, collab_session_id);
                if let Some(client) = self.client.lock().await.as_ref() {
                    client
                        .subscribe(&topic, QoS::AtLeastOnce)
                        .await
                        .map_err(|e| format!("Subscribe to session topic failed: {}", e))?;
                    eprintln!("[MQTT Relay] Subscribed to session topic: {}", topic);
                }
            }
            CollabControlType::CollabEnd => {
                eprintln!(
                    "[MQTT Relay] CollabEnd for session {}",
                    collab_session_id
                );
                let config = self.config.read().await;
                let topic =
                    format!("teamclaw/{}/session/{}", config.team_id, collab_session_id);
                if let Some(client) = self.client.lock().await.as_ref() {
                    let _ = client.unsubscribe(&topic).await;
                    eprintln!("[MQTT Relay] Unsubscribed from session topic: {}", topic);
                }
                self.collab_sessions
                    .lock()
                    .await
                    .remove(&collab_session_id);
            }
            CollabControlType::CollabLeave => {
                eprintln!(
                    "[MQTT Relay] CollabLeave from {} for session {} (no desktop action needed)",
                    ctrl.sender_name, collab_session_id
                );
            }
        }
        Ok(())
    }

    // ─── Collab Chat Request ───────────────────────────────────

    async fn handle_collab_chat_request(
        &self,
        session_id: &str,
        request: &proto::ChatRequest,
    ) -> Result<(), String> {
        // Ignore our own agent broadcasts
        if request.sender_type.as_deref() == Some("agent") {
            return Ok(());
        }

        let opencode_session_id = match self.collab_sessions.lock().await.get(session_id).cloned() {
            Some(id) => id,
            None => {
                eprintln!(
                    "[MQTT Relay] No OpenCode session found for collab session {}",
                    session_id
                );
                return Ok(());
            }
        };

        let content = request.content.clone();
        let sender_name = request.sender_name.clone().unwrap_or_else(|| "Unknown".to_string());
        let has_at_agent = content.to_lowercase().contains("@agent");
        let port = self.opencode_port;
        let collab_session_id = session_id.to_string();

        if has_at_agent {
            let formatted_content = format!("[{}] {}", sender_name, content);

            let sse_url = format!("http://127.0.0.1:{}/event", port);
            let prompt_url = format!(
                "http://127.0.0.1:{}/session/{}/prompt_async",
                port, opencode_session_id
            );

            let http_client = reqwest::Client::new();
            let sse_response = http_client
                .get(&sse_url)
                .header("Accept", "text/event-stream")
                .timeout(Duration::from_secs(900))
                .send()
                .await
                .map_err(|e| format!("SSE connect failed: {}", e))?;

            let body = serde_json::json!({
                "parts": [{ "type": "text", "text": formatted_content }]
            });
            http_client
                .post(&prompt_url)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Prompt send failed: {}", e))?;

            let relay = self.clone();
            let oc_sid = opencode_session_id.clone();
            tokio::spawn(async move {
                match relay
                    .collect_full_response_from_sse(sse_response, &oc_sid)
                    .await
                {
                    Ok(full_text) => {
                        if let Err(e) = relay
                            .broadcast_agent_reply(&collab_session_id, &full_text)
                            .await
                        {
                            eprintln!("[MQTT Relay] Failed to broadcast agent reply: {}", e);
                        }
                    }
                    Err(e) => {
                        eprintln!("[MQTT Relay] Failed to collect agent response: {}", e);
                    }
                }
            });
        } else {
            // No @agent mention — inject as context without triggering a reply
            teamclaw_gateway::inject_context_no_reply(
                port,
                &opencode_session_id,
                &content,
                &sender_name,
            )
            .await?;
        }

        Ok(())
    }

    /// Collect full SSE response text until message.completed or message.updated(done).
    async fn collect_full_response_from_sse(
        &self,
        sse_response: reqwest::Response,
        session_id: &str,
    ) -> Result<String, String> {
        let mut stream = sse_response.bytes_stream();
        let mut buffer = String::new();
        let mut full_text = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(900);

        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    break;
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            buffer.push_str(&String::from_utf8_lossy(&bytes));

                            while let Some(pos) = buffer.find("\n\n") {
                                let event_block = buffer[..pos].to_string();
                                buffer = buffer[pos + 2..].to_string();

                                let mut data = String::new();
                                for line in event_block.lines() {
                                    if let Some(d) = line.strip_prefix("data: ") {
                                        data = d.to_string();
                                    }
                                }

                                if data.is_empty() { continue; }

                                let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else { continue };
                                let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                let props = v.get("properties");

                                // Filter to our session (match against OpenCode session ID)
                                let event_sid = props
                                    .and_then(|p| p.get("sessionID").and_then(|s| s.as_str()))
                                    .or_else(|| props.and_then(|p| p.get("info").and_then(|i| i.get("sessionID").and_then(|s| s.as_str()))));
                                if let Some(sid) = event_sid {
                                    if sid != session_id { continue; }
                                }

                                match event_type {
                                    "message.part.delta" => {
                                        let field = props
                                            .and_then(|p| p.get("field").and_then(|f| f.as_str()))
                                            .unwrap_or("text");
                                        if field == "text" {
                                            if let Some(delta) = props.and_then(|p| p.get("delta").and_then(|d| d.as_str())) {
                                                full_text.push_str(delta);
                                            }
                                        }
                                    }
                                    "message.completed" => {
                                        return Ok(full_text);
                                    }
                                    "message.updated" => {
                                        let is_completed = props
                                            .and_then(|p| p.get("info"))
                                            .and_then(|i| i.get("time"))
                                            .and_then(|t| t.get("completed"))
                                            .is_some();
                                        let is_assistant = props
                                            .and_then(|p| p.get("info"))
                                            .and_then(|i| i.get("role").and_then(|r| r.as_str()))
                                            == Some("assistant");
                                        if is_completed && is_assistant && !full_text.is_empty() {
                                            return Ok(full_text);
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Some(Err(e)) => {
                            return Err(format!("SSE stream error: {}", e));
                        }
                        None => {
                            break;
                        }
                    }
                }
            }
        }

        Ok(full_text)
    }

    /// Broadcast agent reply as a ChatRequest(sender_type=agent) to the session topic.
    async fn broadcast_agent_reply(
        &self,
        collab_session_id: &str,
        content: &str,
    ) -> Result<(), String> {
        let config = self.config.read().await;
        let topic = format!(
            "teamclaw/{}/session/{}",
            config.team_id, collab_session_id
        );

        let msg = build_envelope(proto::mqtt_message::Payload::ChatRequest(
            proto::ChatRequest {
                session_id: collab_session_id.to_string(),
                content: content.to_string(),
                image_url: None,
                model: None,
                permission_mode: None,
                opencode_session_id: None,
                sender_id: Some(config.device_id.clone()),
                sender_name: Some(config.device_name.clone()),
                sender_type: Some("agent".to_string()),
            },
        ));

        let bytes = msg.encode_to_vec();
        if let Some(client) = self.client.lock().await.as_ref() {
            client
                .publish(&topic, QoS::AtLeastOnce, false, bytes)
                .await
                .map_err(|e| format!("Broadcast agent reply failed: {}", e))?;
            eprintln!(
                "[MQTT Relay] Broadcasted agent reply to session topic: {}",
                topic
            );
        } else {
            return Err("MQTT client not connected".to_string());
        }
        Ok(())
    }

    pub async fn sync_all_to_device(
        &self,
        device_id: &str,
        tasks: Vec<proto::AutomationTaskData>,
        skills: Vec<proto::SkillData>,
        members: Vec<proto::MemberData>,
    ) -> Result<(), String> {
        self.sync_tasks(device_id, tasks).await?;
        self.sync_skills(device_id, skills).await?;
        self.sync_members(device_id, members).await?;
        Ok(())
    }
}

// ─── Helpers ───────────────────────────────────────────────────

fn now_timestamp() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn build_envelope(payload: proto::mqtt_message::Payload) -> proto::MqttMessage {
    proto::MqttMessage {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: now_timestamp(),
        payload: Some(payload),
    }
}

fn build_chat_delta(session_id: &str, seq: i32, delta: &str) -> proto::MqttMessage {
    build_envelope(proto::mqtt_message::Payload::ChatResponse(
        proto::ChatResponse {
            session_id: session_id.to_string(),
            seq,
            event: Some(proto::chat_response::Event::Delta(delta.to_string())),
        },
    ))
}

fn build_chat_done(session_id: &str, seq: i32, opencode_session_id: Option<&str>) -> proto::MqttMessage {
    build_envelope(proto::mqtt_message::Payload::ChatResponse(
        proto::ChatResponse {
            session_id: session_id.to_string(),
            seq,
            event: Some(proto::chat_response::Event::Done(proto::StreamDone {
                opencode_session_id: opencode_session_id.map(|s| s.to_string()),
            })),
        },
    ))
}

fn build_chat_error(session_id: &str, seq: i32, message: &str) -> proto::MqttMessage {
    build_envelope(proto::mqtt_message::Payload::ChatResponse(
        proto::ChatResponse {
            session_id: session_id.to_string(),
            seq,
            event: Some(proto::chat_response::Event::Error(proto::StreamError {
                message: message.to_string(),
            })),
        },
    ))
}

fn truncate_string(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{}...(truncated)", truncated)
    }
}

fn build_chat_tool_event(
    session_id: &str,
    seq: i32,
    tool_call_id: &str,
    tool_name: &str,
    status: &str,
    arguments_json: &str,
    result_summary: &str,
    duration_ms: i32,
) -> proto::MqttMessage {
    build_envelope(proto::mqtt_message::Payload::ChatResponse(
        proto::ChatResponse {
            session_id: session_id.to_string(),
            seq,
            event: Some(proto::chat_response::Event::ToolEvent(proto::ToolEvent {
                tool_call_id: tool_call_id.to_string(),
                tool_name: tool_name.to_string(),
                status: status.to_string(),
                arguments_json: truncate_string(arguments_json, 500),
                result_summary: truncate_string(result_summary, 1000),
                duration_ms,
            })),
        },
    ))
}

fn build_chat_has_thinking(session_id: &str, seq: i32) -> proto::MqttMessage {
    build_envelope(proto::mqtt_message::Payload::ChatResponse(
        proto::ChatResponse {
            session_id: session_id.to_string(),
            seq,
            event: Some(proto::chat_response::Event::HasThinking(true)),
        },
    ))
}

struct ParsedRole {
    name: String,
    description: String,
    role: String,
    when_to_use: String,
    working_style: String,
    role_skills: Vec<proto::RoleSkillLink>,
}

/// Parse ROLE.md: frontmatter (name, description) + markdown sections.
fn parse_role_md(content: &str) -> ParsedRole {
    let normalized = content.replace("\r\n", "\n");
    let mut name = String::new();
    let mut description = String::new();
    let body;

    // Parse frontmatter
    if let Some(rest) = normalized.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let frontmatter = &rest[..end];
            for line in frontmatter.lines() {
                if let Some(idx) = line.find(':') {
                    let key = line[..idx].trim();
                    let value = line[idx + 1..].trim();
                    match key {
                        "name" => name = value.to_string(),
                        "description" => description = value.to_string(),
                        _ => {}
                    }
                }
            }
            body = rest[end + 4..].trim().to_string(); // skip "\n---"
        } else {
            body = normalized;
        }
    } else {
        body = normalized;
    }

    // Extract sections by ## heading
    let get_section = |heading: &str| -> String {
        let pattern = format!("## {}", heading);
        if let Some(start) = body.find(&pattern) {
            let after = &body[start + pattern.len()..];
            let trimmed = after.trim_start_matches(|c: char| c == '\n' || c == '\r');
            if let Some(next) = trimmed.find("\n## ") {
                trimmed[..next].trim().to_string()
            } else {
                trimmed.trim().to_string()
            }
        } else {
            String::new()
        }
    };

    let role = get_section("Role");
    let when_to_use = get_section("When to use");
    let working_style = get_section("Working style");
    let skills_section = get_section("Available role skills");

    // Parse role skill links: "- `name`: description"
    let role_skills: Vec<proto::RoleSkillLink> = skills_section
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim().strip_prefix('-')?.trim();
            let backtick_start = trimmed.find('`')?;
            let backtick_end = trimmed[backtick_start + 1..].find('`')? + backtick_start + 1;
            let skill_name = &trimmed[backtick_start + 1..backtick_end];
            let rest = trimmed[backtick_end + 1..].trim().strip_prefix(':')?.trim();
            Some(proto::RoleSkillLink {
                name: skill_name.to_string(),
                description: rest.to_string(),
            })
        })
        .collect();

    ParsedRole {
        name,
        description,
        role,
        when_to_use,
        working_style,
        role_skills,
    }
}

// ============================================================================
// Collab helper functions (extracted for testability)
// ============================================================================

/// Check if message content mentions @Agent (case-insensitive)
pub(crate) fn contains_agent_mention(content: &str) -> bool {
    content.to_lowercase().contains("@agent")
}

/// Parse sender name from "[Name] content" format.
/// Returns (sender_name, clean_content). If no prefix, sender_name is None.
pub(crate) fn parse_sender_prefix(content: &str) -> (Option<String>, String) {
    if content.starts_with('[') {
        if let Some(end) = content.find(']') {
            let name = content[1..end].to_string();
            let clean = content[end + 1..].trim_start().to_string();
            if name.is_empty() {
                return (None, clean);
            }
            return (Some(name), clean);
        }
    }
    (None, content.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── @Agent detection ───────────────────────────────────────────────

    #[test]
    fn test_agent_mention_basic() {
        assert!(contains_agent_mention("@Agent help me"));
        assert!(contains_agent_mention("hey @agent do this"));
        assert!(contains_agent_mention("@AGENT"));
        assert!(contains_agent_mention("test @Agent test"));
    }

    #[test]
    fn test_agent_mention_negative() {
        assert!(!contains_agent_mention("hello world"));
        assert!(!contains_agent_mention("no mention here"));
        assert!(!contains_agent_mention("agent without at sign"));
    }

    #[test]
    fn test_agent_mention_in_email_like_string() {
        // "agent@test.com" does NOT contain "@agent" — the @ precedes "test" not "agent"
        assert!(!contains_agent_mention("agent@test.com"));
    }

    // ─── Sender prefix parsing ──────────────────────────────────────────

    #[test]
    fn test_parse_sender_prefix_chinese_name() {
        let (name, content) = parse_sender_prefix("[张三] hello world");
        assert_eq!(name, Some("张三".to_string()));
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_parse_sender_prefix_english_name() {
        let (name, content) = parse_sender_prefix("[Alice] @Agent help");
        assert_eq!(name, Some("Alice".to_string()));
        assert_eq!(content, "@Agent help");
    }

    #[test]
    fn test_parse_sender_prefix_no_prefix() {
        let (name, content) = parse_sender_prefix("no prefix here");
        assert_eq!(name, None);
        assert_eq!(content, "no prefix here");
    }

    #[test]
    fn test_parse_sender_prefix_empty_brackets() {
        let (name, content) = parse_sender_prefix("[] empty name");
        assert_eq!(name, None);
        assert_eq!(content, "empty name");
    }

    #[test]
    fn test_parse_sender_prefix_no_space_after_bracket() {
        let (name, content) = parse_sender_prefix("[Bob]no space");
        assert_eq!(name, Some("Bob".to_string()));
        assert_eq!(content, "no space");
    }

    #[test]
    fn test_parse_sender_prefix_unclosed_bracket() {
        let (name, content) = parse_sender_prefix("[unclosed bracket");
        assert_eq!(name, None);
        assert_eq!(content, "[unclosed bracket");
    }

    #[test]
    fn test_parse_sender_prefix_with_slash_platform() {
        // Gateway messages use [Name/Platform] format
        let (name, content) = parse_sender_prefix("[小红/WeCom] 开会了");
        assert_eq!(name, Some("小红/WeCom".to_string()));
        assert_eq!(content, "开会了");
    }
}
