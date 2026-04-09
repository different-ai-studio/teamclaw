// src-tauri/src/commands/gateway/mqtt_relay.rs

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex as TokioMutex, RwLock};
use tokio::task::JoinHandle;
use rumqttc::v5::{AsyncClient, MqttOptions, Event, Incoming};
use rumqttc::v5::mqttbytes::QoS;
use futures_util::StreamExt;
use prost::Message as ProstMessage;

use super::mqtt_config::{MqttConfig, PairedDevice, PairingSession, MqttRelayStatus};
use super::mqtt_config::proto;
use crate::commands::team_unified::{TeamManifest, MemberRole};

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
    oss_sync_state: Option<Arc<tokio::sync::Mutex<Option<crate::commands::oss_sync::OssSyncManager>>>>,
    /// Cancel tokens for active SSE streams, keyed by session_id.
    cancel_tokens: Arc<TokioMutex<std::collections::HashMap<String, tokio_util::sync::CancellationToken>>>,
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
        }
    }

    /// Set the OssSyncState reference so the relay can read members from S3.
    pub fn set_oss_sync_state(&mut self, state: Arc<tokio::sync::Mutex<Option<crate::commands::oss_sync::OssSyncManager>>>) {
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
        let mut mqttoptions = MqttOptions::new(
            &client_id,
            &config.broker_host,
            config.broker_port,
        );
        mqttoptions.set_credentials(&config.username, &config.password);
        mqttoptions.set_keep_alive(Duration::from_secs(60));
        mqttoptions.set_clean_start(false);

        let _ = rustls::crypto::ring::default_provider().install_default();
        mqttoptions.set_transport(rumqttc::Transport::tls_with_default_config());

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
            },
        ));
        client
            .publish(
                &status_topic,
                QoS::AtLeastOnce,
                true,
                msg.encode_to_vec(),
            )
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
        self.publish_proto_to_device(device_id, "chat/res", msg).await
    }

    // ─── Incoming message handling ─────────────────────────────

    async fn handle_incoming_message(&self, topic: &str, payload: &[u8]) -> Result<(), String> {
        let parts: Vec<&str> = topic.split('/').collect();

        let msg = proto::MqttMessage::decode(payload)
            .map_err(|e| format!("Protobuf decode failed: {}", e))?;

        let device_id = parts.get(2).map(|s| s.to_string());

        match msg.payload {
            Some(proto::mqtt_message::Payload::PairingRequest(ref req)) => {
                match self.handle_pairing_request(&req.device_id, &req.device_name).await {
                    Ok(device) => {
                        eprintln!("[MQTT Relay] Paired with device: {} ({})", device.device_name, device.device_id);
                    }
                    Err(e) => {
                        eprintln!("[MQTT Relay] Pairing failed: {}", e);
                    }
                }
            }
            Some(proto::mqtt_message::Payload::ChatRequest(ref req)) => {
                self.handle_chat_request(topic, req).await?;
            }
            Some(proto::mqtt_message::Payload::ChatCancel(ref cancel)) => {
                self.handle_chat_cancel(&cancel.session_id).await;
            }
            Some(proto::mqtt_message::Payload::SessionSyncRequest(ref _req)) => {
                if let Some(did) = device_id {
                    self.handle_session_list_request(&did).await?;
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
                if let Some(did) = device_id {
                    self.handle_message_sync_request(&did, req).await?;
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
        let device_id = parts
            .get(2)
            .ok_or("Invalid topic format")?
            .to_string();

        let port = self.opencode_port;
        let session_id = request.session_id.clone();

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
        http_client
            .post(&prompt_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Prompt send failed: {}", e))?;

        // Create cancel token for this stream
        let cancel_token = tokio_util::sync::CancellationToken::new();
        self.cancel_tokens.lock().await.insert(session_id.clone(), cancel_token.clone());

        let relay = self.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            if let Err(e) = relay
                .stream_sse_to_mqtt(sse_response, &device_id, &sid, &cancel_token)
                .await
            {
                eprintln!("[MQTT Relay] SSE streaming error: {}", e);
            }
            relay.cancel_tokens.lock().await.remove(&sid);
        });

        Ok(())
    }

    async fn handle_chat_cancel(&self, session_id: &str) {
        eprintln!("[MQTT Relay] Chat cancel requested for session: {}", session_id);

        // Cancel the local SSE stream
        if let Some(token) = self.cancel_tokens.lock().await.remove(session_id) {
            token.cancel();
        }

        // Also call OpenCode abort API
        let port = self.opencode_port;
        let url = format!("http://127.0.0.1:{}/session/{}/abort", port, session_id);
        let _ = reqwest::Client::new().post(&url).send().await;
    }

    /// Read SSE stream, aggregate tokens every 200ms, publish to MQTT
    async fn stream_sse_to_mqtt(
        &self,
        sse_response: reqwest::Response,
        device_id: &str,
        session_id: &str,
        cancel_token: &tokio_util::sync::CancellationToken,
    ) -> Result<(), String> {
        let mut stream = sse_response.bytes_stream();
        let mut buffer = String::new();
        let mut full_content = String::new();
        let mut seq: i32 = 0;
        let mut last_flush = tokio::time::Instant::now();
        let flush_interval = Duration::from_millis(200);
        let mut pending_delta = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(900);

        loop {
            tokio::select! {
                _ = cancel_token.cancelled() => {
                    // Send done to client so it stops waiting
                    let msg = build_chat_done(session_id, seq);
                    self.publish_chat_response_proto(device_id, &msg).await?;
                    eprintln!("[MQTT Relay] Stream cancelled for session: {}", session_id);
                    break;
                }
                _ = tokio::time::sleep_until(deadline) => {
                    let msg = build_chat_done(session_id, seq);
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

                                // Filter: only process events for our session
                                let event_sid = props
                                    .and_then(|p| p.get("sessionID").and_then(|s| s.as_str()))
                                    .or_else(|| props.and_then(|p| p.get("info").and_then(|i| i.get("sessionID").and_then(|s| s.as_str()))));
                                if let Some(sid) = event_sid {
                                    if sid != session_id { continue; }
                                }

                                match event_type {
                                    "message.part.delta" => {
                                        // {"type":"message.part.delta","properties":{"sessionID":"...","messageID":"...","partID":"...","field":"text","delta":"hello"}}
                                        if let Some(text) = props.and_then(|p| p.get("delta").and_then(|d| d.as_str())) {
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
                                    "message.completed" => {
                                        if !pending_delta.is_empty() {
                                            let msg = build_chat_delta(session_id, seq, &pending_delta);
                                            self.publish_chat_response_proto(device_id, &msg).await?;
                                            seq += 1;
                                            pending_delta.clear();
                                        }
                                        let msg = build_chat_done(session_id, seq);
                                        self.publish_chat_response_proto(device_id, &msg).await?;
                                        return Ok(());
                                    }
                                    "message.updated" => {
                                        // message.updated with time.completed signals assistant message finished
                                        let is_completed = props
                                            .and_then(|p| p.get("info"))
                                            .and_then(|i| i.get("time"))
                                            .and_then(|t| t.get("completed"))
                                            .is_some();
                                        let is_assistant = props
                                            .and_then(|p| p.get("info"))
                                            .and_then(|i| i.get("role").and_then(|r| r.as_str()))
                                            == Some("assistant");
                                        if is_completed && is_assistant && seq > 0 {
                                            if !pending_delta.is_empty() {
                                                let msg = build_chat_delta(session_id, seq, &pending_delta);
                                                self.publish_chat_response_proto(device_id, &msg).await?;
                                                seq += 1;
                                                pending_delta.clear();
                                            }
                                            let msg = build_chat_done(session_id, seq);
                                            self.publish_chat_response_proto(device_id, &msg).await?;
                                            return Ok(());
                                        }
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
                            let msg = build_chat_done(session_id, seq);
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

    async fn handle_session_list_request(&self, device_id: &str) -> Result<(), String> {
        let port = self.opencode_port;
        match super::opencode_list_sessions(port).await {
            Ok(sessions) => {
                let session_data: Vec<proto::SessionData> = sessions
                    .iter()
                    .map(|s| proto::SessionData {
                        id: s.id.clone(),
                        title: s.title.clone(),
                        updated: s.updated / 1000, // Convert ms to seconds
                    })
                    .collect();
                let msg = build_envelope(proto::mqtt_message::Payload::SessionSyncResponse(
                    proto::SessionSyncResponse {
                        sessions: session_data,
                        pagination: Some(proto::PageInfo {
                            page: 1,
                            page_size: 50,
                            total: sessions.len() as i32,
                        }),
                    },
                ));
                self.publish_proto_to_device(device_id, "chat/res", &msg).await?;
            }
            Err(e) => {
                eprintln!("[MQTT Relay] Failed to fetch sessions: {}", e);
            }
        }
        Ok(())
    }

    // ─── Member Sync ───────────────────────────────────────────

    async fn handle_member_sync_request(
        &self,
        device_id: &str,
        _req: &proto::MemberSyncRequest,
    ) -> Result<(), String> {
        let manifest = self.fetch_team_manifest().await?;

        let members: Vec<proto::MemberData> = match manifest {
            Some(m) => m.members.into_iter().map(|tm| proto::MemberData {
                id: tm.node_id,
                name: if tm.name.is_empty() { tm.hostname.clone() } else { tm.name },
                avatar_url: String::new(),
                department: if tm.label.is_empty() { None } else { Some(tm.label) },
                is_ai_ally: tm.role == MemberRole::Seed,
                note: format!("{}/{} ({:?})", tm.platform, tm.arch, tm.role),
            }).collect(),
            None => vec![],
        };

        let total = members.len() as i32;
        let msg = build_envelope(proto::mqtt_message::Payload::MemberSyncResponse(
            proto::MemberSyncResponse {
                members,
                pagination: Some(proto::PageInfo { page: 1, page_size: 50, total }),
            },
        ));
        self.publish_proto_to_device(device_id, "member", &msg).await
    }

    /// Fetch TeamManifest: try P2P local file first, then OSS S3.
    async fn fetch_team_manifest(&self) -> Result<Option<TeamManifest>, String> {
        // Try P2P local file first (fast, no network)
        let manifest_path = format!("{}/teamclaw-team/_team/members.json", self.workspace_path);
        match std::fs::read_to_string(&manifest_path) {
            Ok(content) => match serde_json::from_str::<TeamManifest>(&content) {
                Ok(manifest) => {
                    return Ok(Some(manifest));
                }
                Err(e) => {
                    eprintln!("[MQTT Relay] P2P members.json parse error: {}", e);
                }
            },
            Err(_) => {
                // P2P file not available — fall through to S3
            }
        }

        // Fallback to OSS S3 (if configured)
        match self.oss_sync_state {
            None => {
                eprintln!("[MQTT Relay] No OSS sync state configured, cannot fetch members");
            }
            Some(ref oss_state) => {
                let mut guard = oss_state.lock().await;
                match *guard {
                    None => {
                        eprintln!("[MQTT Relay] OSS manager not initialized, cannot fetch members");
                    }
                    Some(ref mut manager) => {
                        manager.refresh_token_if_needed().await?;
                        let key = format!("teams/{}/_meta/members.json", manager.team_id());
                        match manager.s3_get(&key).await {
                            Ok(data) => {
                                let manifest: TeamManifest = serde_json::from_slice(&data)
                                    .map_err(|e| format!("Failed to parse OSS members.json: {}", e))?;
                                return Ok(Some(manifest));
                            }
                            Err(e) if e.contains("NoSuchKey") || e.contains("not found") => {
                                return Ok(None);
                            }
                            Err(e) => {
                                eprintln!("[MQTT Relay] OSS members fetch failed: {}", e);
                                return Err(format!("OSS members fetch failed: {}", e));
                            }
                        }
                    }
                }
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

        let skills: Vec<proto::SkillData> = if let Ok(content) = std::fs::read_to_string(&lockfile_path) {
            if let Ok(lock) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(skills_map) = lock.get("skills").and_then(|s| s.as_object()) {
                    skills_map.iter().map(|(slug, entry)| {
                        let version = entry.get("version")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        proto::SkillData {
                            id: slug.clone(),
                            name: slug.clone(),
                            description: format!("v{}", version),
                            is_personal: false,
                            is_enabled: true,
                        }
                    }).collect()
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
                pagination: Some(proto::PageInfo { page: 1, page_size: 50, total }),
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
                    if !path.is_dir() { continue; }
                    let slug = entry.file_name().to_string_lossy().to_string();
                    if slug == "skill" || slug == "config.json" { continue; }

                    let role_md = path.join("ROLE.md");
                    if !role_md.exists() { continue; }

                    if let Ok(content) = std::fs::read_to_string(&role_md) {
                        let parsed = parse_role_md(&content);
                        let skill_count = parsed.role_skills.len() as i32;
                        talents.push(proto::TalentData {
                            id: slug.clone(),
                            name: if parsed.name.is_empty() { slug } else { parsed.name },
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
                pagination: Some(proto::PageInfo { page: 1, page_size: 50, total }),
            },
        ));
        self.publish_proto_to_device(device_id, "talent", &msg).await
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

        let tasks: Vec<proto::AutomationTaskData> = if let Ok(content) = std::fs::read_to_string(&cron_path) {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(jobs) = data.get("jobs").and_then(|j| j.as_array()) {
                    jobs.iter().filter_map(|job| {
                        let id = job.get("id")?.as_str()?;
                        let name = job.get("name")?.as_str()?;
                        let enabled = job.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false);
                        let cron_expr = job.get("schedule")
                            .and_then(|s| s.get("expr"))
                            .and_then(|e| e.as_str())
                            .unwrap_or("");
                        let description = job.get("description")
                            .and_then(|d| d.as_str())
                            .unwrap_or("");
                        let last_run = job.get("lastRunAt")
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
                    }).collect()
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
                pagination: Some(proto::PageInfo { page: 1, page_size: 50, total }),
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
        let session_id = &req.session_id;
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
                if role != "user" && role != "assistant" { return None; }

                let parts = msg.get("parts")?.as_array()?;
                let mut content_parts: Vec<String> = Vec::new();
                for part in parts {
                    match part.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                                content_parts.push(text.to_string());
                            }
                        }
                        Some("tool") => {
                            let tool_name = part.get("tool").and_then(|t| t.as_str()).unwrap_or("tool");
                            let input_summary = part.get("state")
                                .and_then(|s| s.get("input"))
                                .map(|input| {
                                    // For websearch/webfetch, show the query/url
                                    if let Some(q) = input.get("query").and_then(|v| v.as_str()) {
                                        q.to_string()
                                    } else if let Some(u) = input.get("url").and_then(|v| v.as_str()) {
                                        u.to_string()
                                    } else {
                                        serde_json::to_string(input).unwrap_or_default()
                                            .chars().take(80).collect()
                                    }
                                })
                                .unwrap_or_default();
                            content_parts.push(format!("🔧 {} {}", tool_name, input_summary));
                        }
                        _ => {}
                    }
                }
                let content = content_parts.join("\n");
                // Skip messages with no displayable content
                if content.trim().is_empty() { return None; }

                // Timestamp: info.time.created (milliseconds) or fallback to 0
                let timestamp_ms = info.get("time")
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
                })
            })
            .collect();

        let msg = build_envelope(proto::mqtt_message::Payload::MessageSyncResponse(
            proto::MessageSyncResponse {
                session_id: session_id.clone(),
                messages,
            },
        ));
        self.publish_proto_to_device(device_id, "chat/res", &msg).await
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
                .publish(
                    &discover_topic,
                    QoS::AtLeastOnce,
                    true,
                    msg.encode_to_vec(),
                )
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

        let mqtt_username = format!(
            "mobile_{}",
            &mobile_device_id[..8.min(mobile_device_id.len())]
        );
        let mqtt_password = uuid::Uuid::new_v4().to_string();

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
            let topic = format!(
                "teamclaw/{}/{}/chat/req",
                config.team_id, mobile_device_id
            );
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
                .publish(
                    &pairing_topic,
                    QoS::AtLeastOnce,
                    false,
                    msg.encode_to_vec(),
                )
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

    // ─── Data Sync ─────────────────────────────────────────────

    pub async fn sync_tasks(
        &self,
        device_id: &str,
        tasks: Vec<proto::AutomationTaskData>,
    ) -> Result<(), String> {
        let msg = build_envelope(proto::mqtt_message::Payload::AutomationSyncResponse(
            proto::AutomationSyncResponse {
                tasks,
                pagination: Some(proto::PageInfo { page: 1, page_size: 50, total: 0 }),
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
                pagination: Some(proto::PageInfo { page: 1, page_size: 50, total: 0 }),
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
                pagination: Some(proto::PageInfo { page: 1, page_size: 50, total: 0 }),
            },
        ));
        self.publish_proto_to_device(device_id, "member", &msg).await
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

fn build_chat_done(session_id: &str, seq: i32) -> proto::MqttMessage {
    build_envelope(proto::mqtt_message::Payload::ChatResponse(
        proto::ChatResponse {
            session_id: session_id.to_string(),
            seq,
            event: Some(proto::chat_response::Event::Done(proto::StreamDone {})),
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

    ParsedRole { name, description, role, when_to_use, working_style, role_skills }
}
