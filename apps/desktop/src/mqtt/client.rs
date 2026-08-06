use anyhow::Result;
use rumqttc::{
    AsyncClient, ConnectReturnCode, Event, EventLoop, LastWill, MqttOptions, Packet, QoS, Transport,
};
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use teamclaw_transport::MqttBroker;
use tokio::sync::Mutex;

pub struct ClientConfig {
    pub broker_url: Option<String>,
    pub broker_host: String,
    pub broker_port: u16,
    pub client_id: String,
    pub username: String,
    pub password: String,
    pub team_id: String,
    pub use_tls: bool,
}

pub struct MqttClient {
    pub client: AsyncClient,
    pub event_loop: Arc<Mutex<EventLoop>>,
    pub client_id: String,
}

impl MqttClient {
    fn resolve_broker(cfg: &ClientConfig) -> MqttBroker {
        let broker_url = cfg
            .broker_url
            .as_deref()
            .filter(|url| !url.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                let scheme = if cfg.use_tls { "mqtts" } else { "mqtt" };
                format!("{}://{}:{}", scheme, cfg.broker_host, cfg.broker_port)
            });
        MqttBroker::parse(&broker_url)
    }

    pub fn connect(cfg: ClientConfig) -> Result<Self> {
        let opts = build_mqtt_options(&cfg, false);
        let (client, event_loop) = AsyncClient::new(opts, 64);
        Ok(Self {
            client,
            event_loop: Arc::new(Mutex::new(event_loop)),
            client_id: cfg.client_id,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttProbeResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub connack_code: Option<String>,
    pub broker_url: String,
}

fn build_mqtt_options(cfg: &ClientConfig, clean_session: bool) -> MqttOptions {
    let broker = MqttClient::resolve_broker(cfg);
    let mut opts = MqttOptions::new(&cfg.client_id, broker.connection_address(), broker.port);
    opts.set_credentials(&cfg.username, &cfg.password);
    opts.set_clean_session(clean_session);
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_max_packet_size(4 * 1024 * 1024, 4 * 1024 * 1024);

    // Not `wss_with_default_config()` / `tls_with_default_config()`: both build
    // `TlsConfiguration::default()`, which panics the process when the platform
    // cert store cannot be read. See `super::tls`.
    if broker.is_websocket() && broker.use_tls {
        opts.set_transport(Transport::Wss(super::tls::default_tls_config()));
    } else if broker.is_websocket() {
        opts.set_transport(Transport::Ws);
    } else if broker.use_tls {
        opts.set_transport(Transport::tls_with_config(super::tls::default_tls_config()));
    }

    if !clean_session {
        let lwt_topic = super::topics::actor_state(&cfg.team_id, &cfg.client_id);
        let lwt_payload = serde_json::json!({"status":"offline"})
            .to_string()
            .into_bytes();
        opts.set_last_will(LastWill::new(
            lwt_topic,
            lwt_payload,
            QoS::AtLeastOnce,
            true,
        ));
    }

    opts
}

/// One-shot broker reachability probe. Does not touch the shared [`MqttBus`].
pub async fn probe_broker(cfg: ClientConfig, timeout: Duration) -> MqttProbeResult {
    let broker_url = cfg
        .broker_url
        .clone()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| {
            let scheme = if cfg.use_tls { "mqtts" } else { "mqtt" };
            format!("{}://{}:{}", scheme, cfg.broker_host, cfg.broker_port)
        });
    let started = Instant::now();
    let deadline = started + timeout;

    let opts = build_mqtt_options(&cfg, true);
    let (client, mut event_loop) = AsyncClient::new(opts, 8);

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = client.disconnect().await;
            return MqttProbeResult {
                ok: false,
                latency_ms: None,
                error: Some(format!("probe timed out after {}ms", timeout.as_millis())),
                connack_code: None,
                broker_url,
            };
        }

        match tokio::time::timeout(remaining, event_loop.poll()).await {
            Ok(Ok(Event::Incoming(Packet::ConnAck(ack)))) => {
                let latency_ms = started.elapsed().as_millis() as u64;
                let connack_code = format!("{:?}", ack.code);
                let _ = client.disconnect().await;
                if ack.code == ConnectReturnCode::Success {
                    return MqttProbeResult {
                        ok: true,
                        latency_ms: Some(latency_ms),
                        error: None,
                        connack_code: Some(connack_code),
                        broker_url,
                    };
                }
                return MqttProbeResult {
                    ok: false,
                    latency_ms: Some(latency_ms),
                    error: Some(format!("broker refused connection: {connack_code}")),
                    connack_code: Some(connack_code),
                    broker_url,
                };
            }
            Ok(Ok(_)) => continue,
            Ok(Err(e)) => {
                let _ = client.disconnect().await;
                return MqttProbeResult {
                    ok: false,
                    latency_ms: None,
                    error: Some(e.to_string()),
                    connack_code: None,
                    broker_url,
                };
            }
            Err(_) => {
                let _ = client.disconnect().await;
                return MqttProbeResult {
                    ok: false,
                    latency_ms: None,
                    error: Some(format!("probe timed out after {}ms", timeout.as_millis())),
                    connack_code: None,
                    broker_url,
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wss_bootstrap_url_uses_port_443_not_js_fallback_1883() {
        let broker = MqttClient::resolve_broker(&ClientConfig {
            broker_url: Some("wss://mqtt.example.com/mqtt".into()),
            broker_host: "mqtt.example.com".into(),
            broker_port: 1883,
            client_id: "teamclaw-test".into(),
            username: "actor".into(),
            password: "token".into(),
            team_id: "team-1".into(),
            use_tls: true,
        });
        assert_eq!(broker.connection_address(), "wss://mqtt.example.com/mqtt");
        assert_eq!(broker.port, 443);
    }
}

pub async fn run_event_loop(bus: Arc<super::MqttBusInner>, app: tauri::AppHandle, generation: u64) {
    use rumqttc::{ConnectReturnCode, Event, Packet};
    use tauri::Emitter;

    // Burst-coalescing forwarder. The daemon drains ACP events in ~50ms
    // batches, so publishes arrive in bursts. Collect everything within an
    // 8ms window into ONE `mqtt:envelopes` emit — cuts webview IPC wakeups
    // ~10x during streaming. Payload bytes are base64 (a serde_json number
    // array would otherwise ~4x the size). Lives for this generation: when
    // run_event_loop returns, env_tx drops and the forwarder exits.
    let (env_tx, mut env_rx) = tokio::sync::mpsc::unbounded_channel::<(String, Vec<u8>)>();
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            use base64::Engine as _;
            while let Some(first) = env_rx.recv().await {
                let mut batch = vec![first];
                let deadline = tokio::time::Instant::now() + Duration::from_millis(8);
                while let Ok(Some(next)) = tokio::time::timeout_at(deadline, env_rx.recv()).await {
                    batch.push(next);
                }
                let payload: Vec<serde_json::Value> = batch
                    .iter()
                    .map(|(topic, bytes)| {
                        serde_json::json!({
                            "topic": topic,
                            "b64": base64::engine::general_purpose::STANDARD
                                .encode(bytes),
                        })
                    })
                    .collect();
                let _ = app.emit("mqtt:envelopes", payload);
            }
        });
    }

    let mut backoff_secs: u64 = 1;
    loop {
        if bus.current_generation() != generation {
            return;
        }
        let event_loop_arc = {
            let guard = bus.client.lock().await;
            guard.as_ref().map(|c| c.event_loop.clone())
        };
        if bus.current_generation() != generation {
            return;
        }
        let Some(event_loop) = event_loop_arc else {
            if bus.current_generation() != generation {
                return;
            }
            bus.set_connected(false);
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        let mut event_loop = event_loop.lock().await;
        let poll_result = event_loop.poll().await;
        if bus.current_generation() != generation {
            return;
        }
        match poll_result {
            Ok(Event::Incoming(Packet::ConnAck(ack))) => {
                if ack.code == ConnectReturnCode::Success {
                    backoff_secs = 1;
                    bus.set_connected(true);
                    tracing::info!("mqtt CONNACK: success");
                    let _ = app.emit("mqtt:connected", true);
                } else {
                    // The broker accepted the TCP/TLS socket but refused the MQTT
                    // session (e.g. bad credentials). Surface the reason instead of
                    // flashing "connected" and letting the socket-close error below
                    // silently flip us back to red with no explanation.
                    bus.set_connected(false);
                    let msg = format!("broker refused connection: {:?}", ack.code);
                    tracing::warn!("mqtt {msg}");
                    let _ = app.emit("mqtt:connected", false);
                    let _ = app.emit("mqtt:error", msg.as_str());
                }
            }
            Ok(Event::Incoming(Packet::Disconnect)) => {
                bus.set_connected(false);
                tracing::warn!("mqtt broker sent DISCONNECT");
                let _ = app.emit("mqtt:connected", false);
            }
            Ok(Event::Incoming(Packet::Publish(p))) => {
                backoff_secs = 1;
                let _ = env_tx.send((p.topic.clone(), p.payload.to_vec()));
            }
            Ok(_) => {
                backoff_secs = 1;
            }
            Err(e) => {
                bus.set_connected(false);
                let msg = e.to_string();
                let _ = app.emit("mqtt:connected", false);
                // Surface the connection failure (auth rejection, refused socket,
                // TLS error, …) to the UI. Previously this only went to the log.
                let _ = app.emit("mqtt:error", msg.as_str());
                tracing::warn!("mqtt event loop error: {msg}, retry in {backoff_secs}s");
                drop(event_loop);
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
            }
        }
    }
}
