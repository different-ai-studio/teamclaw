# Desktop MQTT Relay Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an MQTT relay module to the TeamClaw desktop Tauri app that bridges the iOS mobile client to the local OpenCode Agent via an EMQX broker.

**Architecture:** Follow the existing gateway pattern (Discord, WeChat, WeCom, etc.) — add `mqtt.rs` and `mqtt_config.rs` to `src-tauri/src/commands/gateway/`, register in `GatewayState`, expose Tauri commands. Use `rumqttc` async MQTT client. The relay subscribes to mobile `chat/req` topics, forwards requests to OpenCode via SSE, aggregates streaming responses (200ms buffer), and publishes them back to `chat/res` topics. Also handles device pairing, status publishing, and data sync (tasks, skills, members).

**Tech Stack:** Rust, rumqttc 0.25, tokio, serde_json, Tauri 2.0

---

## File Structure

```
src-tauri/
├── Cargo.toml                                    # Add rumqttc dependency
├── src/
│   ├── lib.rs                                    # Register MqttRelayState + commands
│   └── commands/
│       └── gateway/
│           ├── mod.rs                            # Add mqtt module exports + Tauri commands
│           ├── mqtt_config.rs                    # MqttConfig, PairedDevice, MqttStatusResponse
│           └── mqtt_relay.rs                     # MqttRelay struct: connect, subscribe, publish, pairing
packages/app/
├── src/
│   └── components/settings/
│       └── MobileRelaySettings.tsx               # Frontend UI for MQTT config + pairing
```

---

### Task 1: Add rumqttc Dependency & Config Types

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/commands/gateway/mqtt_config.rs`

- [ ] **Step 1: Add rumqttc to Cargo.toml**

Add to the `[dependencies]` section:

```toml
rumqttc = { version = "0.25", features = ["use-rustls"] }
```

This adds the MQTT 5 async client with TLS support via rustls (consistent with the project's existing TLS approach — no openssl dependency).

- [ ] **Step 2: Create mqtt_config.rs**

```rust
// src-tauri/src/commands/gateway/mqtt_config.rs
use serde::{Deserialize, Serialize};

/// MQTT relay configuration stored in .teamclaw/teamclaw.json
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MqttConfig {
    #[serde(default)]
    pub enabled: bool,
    /// EMQX broker host (e.g., "broker.teamclaw.com")
    #[serde(default)]
    pub broker_host: String,
    /// EMQX broker port (default 8883 for TLS)
    #[serde(default = "default_broker_port")]
    pub broker_port: u16,
    /// MQTT username for this desktop device
    #[serde(default)]
    pub username: String,
    /// MQTT password for this desktop device
    #[serde(default)]
    pub password: String,
    /// Team ID used as topic namespace
    #[serde(default)]
    pub team_id: String,
    /// This desktop device's unique ID
    #[serde(default)]
    pub device_id: String,
    /// This desktop device's display name
    #[serde(default)]
    pub device_name: String,
    /// Paired mobile devices
    #[serde(default)]
    pub paired_devices: Vec<PairedDevice>,
}

fn default_broker_port() -> u16 {
    8883
}

/// A paired mobile device
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub device_id: String,
    pub device_name: String,
    pub mqtt_username: String,
    pub mqtt_password: String,
    pub paired_at: u64, // unix timestamp
}

/// Pairing session (temporary, in-memory only)
#[derive(Debug, Clone)]
pub struct PairingSession {
    pub code: String,         // 6-digit code
    pub created_at: std::time::Instant,
    pub expires_in: std::time::Duration, // 5 minutes
}

impl PairingSession {
    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() > self.expires_in
    }
}

/// Status response for the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttRelayStatus {
    pub connected: bool,
    pub broker_host: Option<String>,
    pub paired_device_count: usize,
    pub error_message: Option<String>,
}

/// MQTT message envelope matching the iOS client's MQTTMessage format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttMessageEnvelope {
    pub id: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub timestamp: f64,
    pub payload: serde_json::Value,
}

/// Chat request payload from mobile
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequestPayload {
    pub session_id: String,
    pub content: String,
    pub image_url: Option<String>,
    pub model: Option<String>,
}

/// Chat response payload to mobile (aggregated streaming chunk)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponsePayload {
    pub session_id: String,
    pub seq: u32,
    pub delta: String,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full: Option<String>,
}

/// Status payload (retained message)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusPayload {
    pub online: bool,
    pub device_name: Option<String>,
}

/// Task update payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskUpdatePayload {
    pub task_id: String,
    pub status: String,
    pub last_run_time: Option<f64>,
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Volumes/openbeta/workspace/teamclaw/.worktrees/mobile-client/src-tauri && cargo check 2>&1 | tail -10
```

Expected: Compiles with no errors (mqtt_config.rs isn't referenced yet, but the Cargo.toml change should resolve).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/commands/gateway/mqtt_config.rs
git commit -m "feat(mobile-relay): add rumqttc dependency and MQTT config types"
```

---

### Task 2: MQTT Relay Core — Connect, Subscribe, Publish

**Files:**
- Create: `src-tauri/src/commands/gateway/mqtt_relay.rs`

- [ ] **Step 1: Create mqtt_relay.rs with MqttRelay struct**

```rust
// src-tauri/src/commands/gateway/mqtt_relay.rs
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex as TokioMutex, RwLock};
use tokio::task::JoinHandle;
use rumqttc::v5::{AsyncClient, MqttOptions, Event, Incoming};
use rumqttc::v5::mqttbytes::QoS;

use super::mqtt_config::*;

pub struct MqttRelay {
    config: Arc<RwLock<MqttConfig>>,
    client: Arc<TokioMutex<Option<AsyncClient>>>,
    event_loop_handle: Arc<TokioMutex<Option<JoinHandle<()>>>>,
    opencode_port: u16,
    workspace_path: String,
    is_connected: Arc<std::sync::atomic::AtomicBool>,
    pairing_session: Arc<TokioMutex<Option<PairingSession>>>,
    error_message: Arc<RwLock<Option<String>>>,
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
        }
    }

    pub async fn set_config(&self, config: MqttConfig) {
        *self.config.write().await = config;
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

    /// Connect to MQTT broker and start event loop
    pub async fn start(&self) -> Result<(), String> {
        let config = self.config.read().await.clone();

        if config.broker_host.is_empty() {
            return Err("MQTT broker host not configured".to_string());
        }

        let client_id = format!("teamclaw-desktop-{}", &config.device_id[..8.min(config.device_id.len())]);
        let mut mqttoptions = MqttOptions::new(
            &client_id,
            &config.broker_host,
            config.broker_port,
        );
        mqttoptions.set_credentials(&config.username, &config.password);
        mqttoptions.set_keep_alive(Duration::from_secs(60));
        mqttoptions.set_clean_start(false);

        // TLS
        mqttoptions.set_transport(rumqttc::Transport::tls_with_default_config());

        let (client, mut eventloop) = AsyncClient::new(mqttoptions, 100);

        // Subscribe to mobile chat requests for all paired devices
        let team_id = config.team_id.clone();
        for device in &config.paired_devices {
            let topic = format!("teamclaw/{}/{}/chat/req", team_id, device.device_id);
            client.subscribe(&topic, QoS::AtLeastOnce).await
                .map_err(|e| format!("Subscribe failed: {}", e))?;
        }

        // Publish online status (retained)
        let status_topic = format!("teamclaw/{}/{}/status", team_id, config.device_id);
        let status = StatusPayload {
            online: true,
            device_name: Some(config.device_name.clone()),
        };
        let status_json = serde_json::to_vec(&MqttMessageEnvelope {
            id: uuid::Uuid::new_v4().to_string(),
            msg_type: "status".to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
            payload: serde_json::to_value(&status).unwrap_or_default(),
        }).unwrap_or_default();
        client.publish(&status_topic, QoS::AtLeastOnce, true, status_json).await
            .map_err(|e| format!("Status publish failed: {}", e))?;

        *self.client.lock().await = Some(client.clone());
        self.is_connected.store(true, std::sync::atomic::Ordering::Relaxed);
        *self.error_message.write().await = None;

        // Spawn event loop
        let relay = self.clone();
        let handle = tokio::spawn(async move {
            loop {
                match eventloop.poll().await {
                    Ok(Event::Incoming(Incoming::Publish(publish))) => {
                        let topic = String::from_utf8_lossy(&publish.topic).to_string();
                        let payload = publish.payload.to_vec();
                        let relay_clone = relay.clone();
                        tokio::spawn(async move {
                            if let Err(e) = relay_clone.handle_incoming_message(&topic, &payload).await {
                                eprintln!("[MQTT Relay] Error handling message: {}", e);
                            }
                        });
                    }
                    Ok(_) => {} // Other events (connack, suback, etc.)
                    Err(e) => {
                        eprintln!("[MQTT Relay] Event loop error: {}", e);
                        relay.is_connected.store(false, std::sync::atomic::Ordering::Relaxed);
                        *relay.error_message.write().await = Some(format!("{}", e));
                        // rumqttc auto-reconnects, just log the error
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        });

        *self.event_loop_handle.lock().await = Some(handle);
        Ok(())
    }

    /// Disconnect from MQTT broker
    pub async fn stop(&self) -> Result<(), String> {
        // Publish offline status before disconnecting
        if let Some(client) = self.client.lock().await.as_ref() {
            let config = self.config.read().await;
            let status_topic = format!("teamclaw/{}/{}/status", config.team_id, config.device_id);
            let status = StatusPayload {
                online: false,
                device_name: None,
            };
            let envelope = MqttMessageEnvelope {
                id: uuid::Uuid::new_v4().to_string(),
                msg_type: "status".to_string(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64(),
                payload: serde_json::to_value(&status).unwrap_or_default(),
            };
            let _ = client.publish(
                &status_topic,
                QoS::AtLeastOnce,
                true, // retained
                serde_json::to_vec(&envelope).unwrap_or_default(),
            ).await;

            let _ = client.disconnect().await;
        }

        // Cancel event loop
        if let Some(handle) = self.event_loop_handle.lock().await.take() {
            handle.abort();
        }

        *self.client.lock().await = None;
        self.is_connected.store(false, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    /// Publish a message to a specific topic
    pub async fn publish_to_device(
        &self,
        device_id: &str,
        subtopic: &str,
        envelope: &MqttMessageEnvelope,
    ) -> Result<(), String> {
        let config = self.config.read().await;
        let topic = format!("teamclaw/{}/{}/{}", config.team_id, device_id, subtopic);
        let payload = serde_json::to_vec(envelope)
            .map_err(|e| format!("JSON serialize failed: {}", e))?;

        if let Some(client) = self.client.lock().await.as_ref() {
            client.publish(&topic, QoS::AtLeastOnce, false, payload).await
                .map_err(|e| format!("Publish failed: {}", e))?;
        } else {
            return Err("MQTT client not connected".to_string());
        }
        Ok(())
    }

    /// Handle incoming MQTT message from mobile device
    async fn handle_incoming_message(&self, topic: &str, payload: &[u8]) -> Result<(), String> {
        let envelope: MqttMessageEnvelope = serde_json::from_slice(payload)
            .map_err(|e| format!("JSON parse failed: {}", e))?;

        match envelope.msg_type.as_str() {
            "chat_request" => {
                let request: ChatRequestPayload = serde_json::from_value(envelope.payload.clone())
                    .map_err(|e| format!("Invalid chat_request payload: {}", e))?;
                self.handle_chat_request(topic, &request).await?;
            }
            _ => {
                eprintln!("[MQTT Relay] Unknown message type: {}", envelope.msg_type);
            }
        }
        Ok(())
    }

    /// Forward a mobile chat request to OpenCode and stream response back
    async fn handle_chat_request(
        &self,
        source_topic: &str,
        request: &ChatRequestPayload,
    ) -> Result<(), String> {
        // Extract device_id from topic: teamclaw/{team_id}/{device_id}/chat/req
        let parts: Vec<&str> = source_topic.split('/').collect();
        let device_id = parts.get(2).ok_or("Invalid topic format")?;

        let port = self.opencode_port;
        let session_id = &request.session_id;
        let content = &request.content;

        // Build the prompt parts (same format as other gateways)
        let mut parts_vec = vec![
            serde_json::json!({
                "type": "text",
                "text": content
            })
        ];

        // If image URL is provided, add it
        if let Some(image_url) = &request.image_url {
            if !image_url.is_empty() {
                parts_vec.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": image_url }
                }));
            }
        }

        // Connect to SSE first
        let sse_url = format!("http://127.0.0.1:{}/event", port);
        let prompt_url = format!("http://127.0.0.1:{}/session/{}/prompt_async", port, session_id);

        let http_client = reqwest::Client::new();

        let sse_response = http_client
            .get(&sse_url)
            .header("Accept", "text/event-stream")
            .timeout(Duration::from_secs(900))
            .send()
            .await
            .map_err(|e| format!("SSE connect failed: {}", e))?;

        // Send prompt async
        let body = serde_json::json!({
            "parts": parts_vec,
        });
        http_client
            .post(&prompt_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Prompt send failed: {}", e))?;

        // Stream SSE events, aggregate, and publish to MQTT
        let relay = self.clone();
        let device_id = device_id.to_string();
        let session_id = session_id.to_string();
        tokio::spawn(async move {
            if let Err(e) = relay.stream_sse_to_mqtt(
                sse_response,
                &device_id,
                &session_id,
            ).await {
                eprintln!("[MQTT Relay] SSE streaming error: {}", e);
            }
        });

        Ok(())
    }

    /// Read SSE stream, aggregate tokens every 200ms, publish to MQTT
    async fn stream_sse_to_mqtt(
        &self,
        sse_response: reqwest::Response,
        device_id: &str,
        session_id: &str,
    ) -> Result<(), String> {
        use futures_util::StreamExt;

        let mut stream = sse_response.bytes_stream();
        let mut buffer = String::new();
        let mut full_content = String::new();
        let mut seq: u32 = 0;
        let mut last_flush = tokio::time::Instant::now();
        let flush_interval = Duration::from_millis(200);
        let mut pending_delta = String::new();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(900);

        loop {
            let chunk = tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    // Timeout — send done
                    self.publish_chat_response(device_id, session_id, seq, "", true, Some(&full_content)).await?;
                    break;
                }
                // Flush timer: if we have pending delta and 200ms passed
                _ = tokio::time::sleep(flush_interval), if !pending_delta.is_empty() => {
                    // Flush accumulated tokens
                    self.publish_chat_response(device_id, session_id, seq, &pending_delta, false, None).await?;
                    full_content.push_str(&pending_delta);
                    pending_delta.clear();
                    seq += 1;
                    last_flush = tokio::time::Instant::now();
                    continue;
                }
                chunk = stream.next() => chunk,
            };

            match chunk {
                Some(Ok(bytes)) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    // Parse SSE lines
                    while let Some(pos) = buffer.find("\n\n") {
                        let event_block = buffer[..pos].to_string();
                        buffer = buffer[pos + 2..].to_string();

                        // Parse event type and data
                        let mut event_type = String::new();
                        let mut data = String::new();
                        for line in event_block.lines() {
                            if let Some(t) = line.strip_prefix("event: ") {
                                event_type = t.to_string();
                            } else if let Some(d) = line.strip_prefix("data: ") {
                                data = d.to_string();
                            }
                        }

                        match event_type.as_str() {
                            "message.delta" => {
                                // Accumulate delta text
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                                    if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                                        pending_delta.push_str(text);

                                        // If 200ms has passed, flush now
                                        if last_flush.elapsed() >= flush_interval && !pending_delta.is_empty() {
                                            self.publish_chat_response(device_id, session_id, seq, &pending_delta, false, None).await?;
                                            full_content.push_str(&pending_delta);
                                            pending_delta.clear();
                                            seq += 1;
                                            last_flush = tokio::time::Instant::now();
                                        }
                                    }
                                }
                            }
                            "message.done" => {
                                // Flush any remaining delta
                                if !pending_delta.is_empty() {
                                    full_content.push_str(&pending_delta);
                                    pending_delta.clear();
                                }

                                // Send final message with full content
                                self.publish_chat_response(device_id, session_id, seq, "", true, Some(&full_content)).await?;
                                return Ok(());
                            }
                            _ => {} // Ignore other events
                        }
                    }
                }
                Some(Err(e)) => {
                    return Err(format!("SSE stream error: {}", e));
                }
                None => {
                    // Stream ended
                    if !pending_delta.is_empty() {
                        full_content.push_str(&pending_delta);
                    }
                    self.publish_chat_response(device_id, session_id, seq, "", true, Some(&full_content)).await?;
                    break;
                }
            }
        }
        Ok(())
    }

    /// Publish a chat response chunk to the mobile device
    async fn publish_chat_response(
        &self,
        device_id: &str,
        session_id: &str,
        seq: u32,
        delta: &str,
        done: bool,
        full: Option<&str>,
    ) -> Result<(), String> {
        let payload = ChatResponsePayload {
            session_id: session_id.to_string(),
            seq,
            delta: delta.to_string(),
            done,
            full: full.map(|s| s.to_string()),
        };
        let envelope = MqttMessageEnvelope {
            id: uuid::Uuid::new_v4().to_string(),
            msg_type: "chat_response".to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
            payload: serde_json::to_value(&payload).unwrap_or_default(),
        };
        self.publish_to_device(device_id, "chat/res", &envelope).await
    }
}
```

- [ ] **Step 2: Verify build**

```bash
cd /Volumes/openbeta/workspace/teamclaw/.worktrees/mobile-client/src-tauri && cargo check 2>&1 | tail -10
```

Note: mqtt_relay.rs isn't referenced from mod.rs yet, so it won't be compiled. Just verify Cargo.toml / config compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/gateway/mqtt_relay.rs
git commit -m "feat(mobile-relay): add MqttRelay core with connect, subscribe, SSE streaming, and 200ms aggregation"
```

---

### Task 3: Device Pairing

**Files:**
- Modify: `src-tauri/src/commands/gateway/mqtt_relay.rs`

- [ ] **Step 1: Add pairing methods to MqttRelay**

Add these methods to the `impl MqttRelay` block:

```rust
    /// Generate a 6-digit pairing code, valid for 5 minutes
    pub async fn generate_pairing_code(&self) -> Result<String, String> {
        use rand::Rng;
        let code: String = {
            let mut rng = rand::thread_rng();
            (0..6).map(|_| rng.gen_range(0..10).to_string()).collect()
        };

        let session = PairingSession {
            code: code.clone(),
            created_at: std::time::Instant::now(),
            expires_in: Duration::from_secs(300), // 5 minutes
        };
        *self.pairing_session.lock().await = Some(session);

        // Subscribe to pairing topic
        if let Some(client) = self.client.lock().await.as_ref() {
            let config = self.config.read().await;
            let pairing_topic = format!("teamclaw/{}/pairing/{}", config.team_id, code);
            client.subscribe(&pairing_topic, QoS::AtLeastOnce).await
                .map_err(|e| format!("Subscribe to pairing topic failed: {}", e))?;
        }

        Ok(code)
    }

    /// Handle pairing request from mobile device
    pub async fn handle_pairing_request(
        &self,
        mobile_device_id: &str,
        mobile_device_name: &str,
    ) -> Result<PairedDevice, String> {
        // Verify pairing session exists and isn't expired
        let session = self.pairing_session.lock().await.take()
            .ok_or("No active pairing session")?;

        if session.is_expired() {
            return Err("Pairing code has expired".to_string());
        }

        // Generate MQTT credentials for the mobile device
        let mqtt_username = format!("mobile_{}", &mobile_device_id[..8.min(mobile_device_id.len())]);
        let mqtt_password = uuid::Uuid::new_v4().to_string();

        let device = PairedDevice {
            device_id: mobile_device_id.to_string(),
            device_name: mobile_device_name.to_string(),
            mqtt_username: mqtt_username.clone(),
            mqtt_password: mqtt_password.clone(),
            paired_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        };

        // Add to config
        {
            let mut config = self.config.write().await;
            config.paired_devices.push(device.clone());
        }

        // Subscribe to new device's topics
        if let Some(client) = self.client.lock().await.as_ref() {
            let config = self.config.read().await;
            let topic = format!("teamclaw/{}/{}/chat/req", config.team_id, mobile_device_id);
            client.subscribe(&topic, QoS::AtLeastOnce).await
                .map_err(|e| format!("Subscribe failed: {}", e))?;
        }

        // Publish pairing response to the mobile device via the pairing topic
        if let Some(client) = self.client.lock().await.as_ref() {
            let config = self.config.read().await;
            let response = serde_json::json!({
                "status": "paired",
                "mqtt_host": config.broker_host,
                "mqtt_port": config.broker_port,
                "mqtt_username": mqtt_username,
                "mqtt_password": mqtt_password,
                "team_id": config.team_id,
                "device_id": mobile_device_id,
                "desktop_device_name": config.device_name,
            });
            let pairing_topic = format!("teamclaw/{}/pairing/{}", config.team_id, session.code);
            client.publish(
                &pairing_topic,
                QoS::AtLeastOnce,
                false,
                serde_json::to_vec(&response).unwrap_or_default(),
            ).await.map_err(|e| format!("Pairing response publish failed: {}", e))?;
        }

        Ok(device)
    }

    /// Remove a paired device
    pub async fn unpair_device(&self, device_id: &str) -> Result<(), String> {
        let mut config = self.config.write().await;
        config.paired_devices.retain(|d| d.device_id != device_id);

        // Unsubscribe from device topics
        if let Some(client) = self.client.lock().await.as_ref() {
            let topic = format!("teamclaw/{}/{}/chat/req", config.team_id, device_id);
            let _ = client.unsubscribe(&topic).await;
        }

        Ok(())
    }
```

- [ ] **Step 2: Add `rand` dependency if not already present**

Check `Cargo.toml` for `rand`. If not present, add:
```toml
rand = "0.8"
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/gateway/mqtt_relay.rs src-tauri/Cargo.toml
git commit -m "feat(mobile-relay): add device pairing with 6-digit code and MQTT credential generation"
```

---

### Task 4: Data Sync (Tasks, Skills, Members)

**Files:**
- Modify: `src-tauri/src/commands/gateway/mqtt_relay.rs`

- [ ] **Step 1: Add sync methods to MqttRelay**

```rust
    /// Sync automation tasks to a specific mobile device
    pub async fn sync_tasks(
        &self,
        device_id: &str,
        tasks: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        let envelope = MqttMessageEnvelope {
            id: uuid::Uuid::new_v4().to_string(),
            msg_type: "task_update".to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
            payload: serde_json::json!({ "tasks": tasks }),
        };
        self.publish_to_device(device_id, "task", &envelope).await
    }

    /// Sync skills to a specific mobile device
    pub async fn sync_skills(
        &self,
        device_id: &str,
        skills: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        let envelope = MqttMessageEnvelope {
            id: uuid::Uuid::new_v4().to_string(),
            msg_type: "skill_sync".to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
            payload: serde_json::json!({ "skills": skills }),
        };
        self.publish_to_device(device_id, "skill", &envelope).await
    }

    /// Sync team members to a specific mobile device
    pub async fn sync_members(
        &self,
        device_id: &str,
        members: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        let envelope = MqttMessageEnvelope {
            id: uuid::Uuid::new_v4().to_string(),
            msg_type: "member_sync".to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
            payload: serde_json::json!({ "members": members }),
        };
        self.publish_to_device(device_id, "member", &envelope).await
    }

    /// Sync all data to all paired devices (called on connect or on demand)
    pub async fn sync_all_to_device(
        &self,
        device_id: &str,
        tasks: Vec<serde_json::Value>,
        skills: Vec<serde_json::Value>,
        members: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        self.sync_tasks(device_id, tasks).await?;
        self.sync_skills(device_id, skills).await?;
        self.sync_members(device_id, members).await?;
        Ok(())
    }
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/commands/gateway/mqtt_relay.rs
git commit -m "feat(mobile-relay): add task, skill, and member sync to mobile devices"
```

---

### Task 5: Register in Gateway Module & Tauri Commands

**Files:**
- Modify: `src-tauri/src/commands/gateway/mod.rs` (add module exports, GatewayState field, Tauri commands)
- Modify: `src-tauri/src/lib.rs` (register commands)

- [ ] **Step 1: Add module exports to gateway/mod.rs**

At the top of `mod.rs`, add:
```rust
pub mod mqtt_config;
pub mod mqtt_relay;
pub use mqtt_config::*;
pub use mqtt_relay::MqttRelay;
```

- [ ] **Step 2: Add mqtt_relay field to GatewayState**

Find the `GatewayState` struct in `mod.rs` and add:
```rust
pub mqtt_relay: Mutex<Option<MqttRelay>>,
```

- [ ] **Step 3: Add MqttConfig to ChannelsConfig**

Find `ChannelsConfig` in `config.rs` and add:
```rust
pub mqtt: Option<MqttConfig>,
```

Add the import: `use super::mqtt_config::MqttConfig;`

- [ ] **Step 4: Add Tauri command functions to gateway/mod.rs**

Add at the bottom of `mod.rs`:

```rust
// ─── MQTT Relay Commands ───────────────────────────────────────────

#[tauri::command]
pub async fn get_mqtt_relay_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<MqttConfig, String> {
    let guard = opencode_state.inner.lock().map_err(|e| e.to_string())?;
    let workspace_path = guard.workspace_path.clone().ok_or("No workspace path")?;
    let config = read_config(&workspace_path)?;
    Ok(config.channels.and_then(|c| c.mqtt).unwrap_or_default())
}

#[tauri::command]
pub async fn save_mqtt_relay_config(
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
    config: MqttConfig,
) -> Result<(), String> {
    let guard = opencode_state.inner.lock().map_err(|e| e.to_string())?;
    let workspace_path = guard.workspace_path.clone().ok_or("No workspace path")?;
    drop(guard);

    // Read existing config, update mqtt section, write back
    let mut full_config = read_config(&workspace_path).unwrap_or_default();
    let mut channels = full_config.channels.unwrap_or_default();
    channels.mqtt = Some(config.clone());
    full_config.channels = Some(channels);
    write_config(&workspace_path, &full_config)?;

    // Update running relay if exists
    if let Some(relay) = gateway_state.mqtt_relay.lock().map_err(|e| e.to_string())?.as_ref() {
        relay.set_config(config).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn start_mqtt_relay(
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let guard = opencode_state.inner.lock().map_err(|e| e.to_string())?;
    let port = guard.port;
    let workspace_path = guard.workspace_path.clone().ok_or("No workspace path")?;
    drop(guard);

    let mqtt_config = read_config(&workspace_path)?
        .channels
        .and_then(|c| c.mqtt)
        .ok_or("MQTT relay config not found")?;

    let mut relay_guard = gateway_state.mqtt_relay.lock().map_err(|e| e.to_string())?;

    if relay_guard.is_none() {
        let relay = MqttRelay::new(port, workspace_path);
        *relay_guard = Some(relay);
    }

    if let Some(relay) = relay_guard.as_ref() {
        relay.set_config(mqtt_config).await;
        relay.start().await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_mqtt_relay(
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    if let Some(relay) = gateway_state.mqtt_relay.lock().map_err(|e| e.to_string())?.as_ref() {
        relay.stop().await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_mqtt_relay_status(
    gateway_state: State<'_, GatewayState>,
) -> Result<MqttRelayStatus, String> {
    if let Some(relay) = gateway_state.mqtt_relay.lock().map_err(|e| e.to_string())?.as_ref() {
        Ok(relay.get_status().await)
    } else {
        Ok(MqttRelayStatus {
            connected: false,
            broker_host: None,
            paired_device_count: 0,
            error_message: None,
        })
    }
}

#[tauri::command]
pub async fn generate_mqtt_pairing_code(
    gateway_state: State<'_, GatewayState>,
) -> Result<String, String> {
    let relay = gateway_state.mqtt_relay.lock().map_err(|e| e.to_string())?
        .as_ref()
        .ok_or("MQTT relay not started")?
        .clone();
    relay.generate_pairing_code().await
}

#[tauri::command]
pub async fn unpair_mqtt_device(
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
    device_id: String,
) -> Result<(), String> {
    let relay_guard = gateway_state.mqtt_relay.lock().map_err(|e| e.to_string())?;
    if let Some(relay) = relay_guard.as_ref() {
        relay.unpair_device(&device_id).await?;

        // Persist updated config
        let guard = opencode_state.inner.lock().map_err(|e| e.to_string())?;
        let workspace_path = guard.workspace_path.clone().ok_or("No workspace path")?;
        drop(guard);

        let config = relay.config.read().await.clone();
        let mut full_config = read_config(&workspace_path).unwrap_or_default();
        let mut channels = full_config.channels.unwrap_or_default();
        channels.mqtt = Some(config);
        full_config.channels = Some(channels);
        write_config(&workspace_path, &full_config)?;
    }
    Ok(())
}
```

- [ ] **Step 5: Register commands in lib.rs**

Find the `.invoke_handler(tauri::generate_handler![...])` block in `lib.rs` and add:

```rust
commands::gateway::get_mqtt_relay_config,
commands::gateway::save_mqtt_relay_config,
commands::gateway::start_mqtt_relay,
commands::gateway::stop_mqtt_relay,
commands::gateway::get_mqtt_relay_status,
commands::gateway::generate_mqtt_pairing_code,
commands::gateway::unpair_mqtt_device,
```

- [ ] **Step 6: Verify build**

```bash
cd /Volumes/openbeta/workspace/teamclaw/.worktrees/mobile-client/src-tauri && cargo check 2>&1 | tail -20
```

Expected: Compiles (may have warnings about unused code, that's fine).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/gateway/mod.rs src-tauri/src/commands/gateway/config.rs src-tauri/src/lib.rs
git commit -m "feat(mobile-relay): register MQTT relay in gateway module with Tauri commands"
```

---

### Task 6: Frontend Settings UI

**Files:**
- Create: `packages/app/src/components/settings/MobileRelaySettings.tsx`

- [ ] **Step 1: Identify existing settings pattern**

Read an existing gateway settings component (e.g., WeComSettings or DiscordSettings) to follow the same pattern for state, invoke, and UI structure.

- [ ] **Step 2: Create MobileRelaySettings.tsx**

A React component that:
1. Loads MQTT relay config on mount via `invoke("get_mqtt_relay_config")`
2. Shows connection status via `invoke("get_mqtt_relay_status")`
3. Allows editing broker host, port, username, password, team_id, device_name
4. Save button calls `invoke("save_mqtt_relay_config", { config })`
5. Start/Stop toggle calls `invoke("start_mqtt_relay")` / `invoke("stop_mqtt_relay")`
6. "生成配对码" button calls `invoke("generate_mqtt_pairing_code")` and displays the 6-digit code
7. Paired devices list with "解除配对" button per device

Follow the existing settings component patterns (Radix UI, Tailwind, i18n).

- [ ] **Step 3: Add to settings page navigation**

Find where other gateway settings are rendered in the settings page and add MobileRelaySettings alongside them.

- [ ] **Step 4: Verify frontend build**

```bash
cd /Volumes/openbeta/workspace/teamclaw/.worktrees/mobile-client && pnpm build 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings/
git commit -m "feat(mobile-relay): add frontend settings UI for MQTT relay configuration and pairing"
```

---

### Task 7: Integration Test & Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Verify Rust build**

```bash
cd /Volumes/openbeta/workspace/teamclaw/.worktrees/mobile-client/src-tauri && cargo build 2>&1 | tail -10
```

- [ ] **Step 2: Verify frontend build**

```bash
cd /Volumes/openbeta/workspace/teamclaw/.worktrees/mobile-client && pnpm build 2>&1 | tail -10
```

- [ ] **Step 3: Run existing tests**

```bash
cd /Volumes/openbeta/workspace/teamclaw/.worktrees/mobile-client/src-tauri && cargo test 2>&1 | tail -10
```

- [ ] **Step 4: Update design spec status**

Edit `docs/superpowers/specs/2026-04-02-ios-mobile-client-design.md`, change `**Status:** V1 Implementation Complete` to `**Status:** Desktop Relay Implementation Complete`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/
git commit -m "docs(mobile-relay): mark desktop MQTT relay as implementation complete"
```
