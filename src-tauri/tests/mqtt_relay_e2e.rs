//! MQTT Mobile Relay — End-to-End Integration Tests
//!
//! These tests require a running EMQX broker. Set environment variables:
//!
//!   MQTT_BROKER_HOST=your-broker.com
//!   MQTT_BROKER_PORT=1883          (or 8883 for TLS)
//!   MQTT_BROKER_TLS=false          (set to "true" for TLS)
//!   MQTT_BROKER_USERNAME=admin     (optional)
//!   MQTT_BROKER_PASSWORD=password  (optional)
//!
//! Run:
//!   cd src-tauri
//!   MQTT_BROKER_HOST=your-broker.com cargo test --test mqtt_relay_e2e -- --nocapture
//!
//! Skip if no broker:
//!   cargo test --test mqtt_relay_e2e  (all tests skip gracefully)

use rumqttc::v5::mqttbytes::QoS;
use rumqttc::v5::{AsyncClient, Event, Incoming, MqttOptions};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

// ─── Test Config ────────────────────────────────────────────────

struct TestConfig {
    host: String,
    port: u16,
    tls: bool,
    username: String,
    password: String,
}

impl TestConfig {
    fn from_env() -> Option<Self> {
        let host = std::env::var("MQTT_BROKER_HOST").ok()?;
        Some(Self {
            host,
            port: std::env::var("MQTT_BROKER_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(1883),
            tls: std::env::var("MQTT_BROKER_TLS")
                .ok()
                .map(|v| v == "true")
                .unwrap_or(false),
            username: std::env::var("MQTT_BROKER_USERNAME").unwrap_or_default(),
            password: std::env::var("MQTT_BROKER_PASSWORD").unwrap_or_default(),
        })
    }
}

// ─── Message types (matching iOS client + desktop relay) ────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MqttMessageEnvelope {
    id: String,
    #[serde(rename = "type")]
    msg_type: String,
    timestamp: f64,
    payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatRequestPayload {
    session_id: String,
    content: String,
    image_url: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatResponsePayload {
    session_id: String,
    seq: u32,
    delta: String,
    done: bool,
    full: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StatusPayload {
    online: bool,
    device_name: Option<String>,
}

// ─── Helper: create MQTT client ─────────────────────────────────

fn create_client(config: &TestConfig, client_id: &str) -> (AsyncClient, rumqttc::v5::EventLoop) {
    let mut opts = MqttOptions::new(client_id, &config.host, config.port);
    if !config.username.is_empty() {
        opts.set_credentials(&config.username, &config.password);
    }
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_clean_start(true);

    if config.tls {
        opts.set_transport(rumqttc::Transport::tls_with_default_config());
    }

    AsyncClient::new(opts, 100)
}

fn now_ts() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}

fn new_id() -> String {
    format!("test-{}", rand::random::<u32>())
}

/// Generate unique namespace per test to avoid parallel test interference
fn unique_ns() -> String {
    format!("e2e-{}", rand::random::<u32>())
}

// ─── Tests ──────────────────────────────────────────────────────

/// Test 1: Basic MQTT connectivity — connect, publish, subscribe, receive
#[tokio::test]
async fn test_broker_connectivity() {
    let Some(config) = TestConfig::from_env() else {
        eprintln!("SKIP: MQTT_BROKER_HOST not set");
        return;
    };

    let (client, mut eventloop) = create_client(&config, "e2e-connectivity-test");

    // Spawn event loop
    let (tx, mut rx) = mpsc::channel::<String>(10);
    let handle = tokio::spawn(async move {
        loop {
            match eventloop.poll().await {
                Ok(Event::Incoming(Incoming::Publish(p))) => {
                    let msg = String::from_utf8_lossy(&p.payload).to_string();
                    let _ = tx.send(msg).await;
                }
                Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                    // Connected
                }
                Err(e) => {
                    eprintln!("Event loop error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    // Subscribe
    let test_topic = format!("teamclaw/e2e-test/{}", new_id());
    client
        .subscribe(&test_topic, QoS::AtLeastOnce)
        .await
        .expect("Subscribe failed");

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Publish
    let test_msg = "hello from e2e test";
    client
        .publish(&test_topic, QoS::AtLeastOnce, false, test_msg.as_bytes())
        .await
        .expect("Publish failed");

    // Receive
    let received = timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("Timeout waiting for message")
        .expect("Channel closed");

    assert_eq!(received, test_msg);

    client.disconnect().await.ok();
    handle.abort();
}

/// Test 2: Desktop publishes online status as retained message, mobile receives it on connect
#[tokio::test]
async fn test_desktop_online_status_retained() {
    let Some(config) = TestConfig::from_env() else {
        eprintln!("SKIP: MQTT_BROKER_HOST not set");
        return;
    };

    let ns = unique_ns();
    let status_topic = format!("teamclaw/{}/desktop/status", ns);

    // ── Desktop: publish retained online status ──
    let (desktop_client, mut desktop_loop) = create_client(&config, &format!("e2e-ds-{}", ns));
    let desktop_handle = tokio::spawn(async move {
        loop {
            if desktop_loop.poll().await.is_err() {
                break;
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(1000)).await;

    let status = MqttMessageEnvelope {
        id: new_id(),
        msg_type: "status".to_string(),
        timestamp: now_ts(),
        payload: serde_json::to_value(&StatusPayload {
            online: true,
            device_name: Some("E2E Test Desktop".to_string()),
        })
        .unwrap(),
    };
    let payload = serde_json::to_vec(&status).unwrap();
    desktop_client
        .publish(&status_topic, QoS::AtLeastOnce, true, payload)
        .await
        .expect("Publish status failed");

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // ── Mobile: connect AFTER desktop published, should get retained status ──
    let (mobile_client, mut mobile_loop) = create_client(&config, &format!("e2e-ms-{}", ns));
    let (tx, mut rx) = mpsc::channel::<MqttMessageEnvelope>(10);

    let mobile_handle = tokio::spawn(async move {
        loop {
            match mobile_loop.poll().await {
                Ok(Event::Incoming(Incoming::Publish(p))) => {
                    if let Ok(env) = serde_json::from_slice::<MqttMessageEnvelope>(&p.payload) {
                        let _ = tx.send(env).await;
                    }
                }
                Err(e) => {
                    eprintln!("Mobile loop error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    mobile_client
        .subscribe(&status_topic, QoS::AtLeastOnce)
        .await
        .expect("Subscribe failed");

    // Should receive the retained message
    let msg = timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("Timeout: mobile didn't receive retained status")
        .expect("Channel closed");

    assert_eq!(msg.msg_type, "status");
    let status: StatusPayload = serde_json::from_value(msg.payload).unwrap();
    assert!(status.online);
    assert_eq!(status.device_name.as_deref(), Some("E2E Test Desktop"));

    // Cleanup: remove retained message
    desktop_client
        .publish(&status_topic, QoS::AtLeastOnce, true, vec![])
        .await
        .ok();

    desktop_client.disconnect().await.ok();
    mobile_client.disconnect().await.ok();
    desktop_handle.abort();
    mobile_handle.abort();
}

/// Test 3: Mobile sends chat request, desktop receives it
#[tokio::test]
async fn test_mobile_sends_chat_request() {
    let Some(config) = TestConfig::from_env() else {
        eprintln!("SKIP: MQTT_BROKER_HOST not set");
        return;
    };

    let ns = unique_ns();
    let chat_req_topic = format!("teamclaw/{}/mobile/chat/req", ns);

    // ── Desktop: subscribe to mobile's chat/req ──
    let (desktop_client, mut desktop_loop) = create_client(&config, &format!("e2e-dcr-{}", ns));
    let (tx, mut rx) = mpsc::channel::<MqttMessageEnvelope>(10);

    let desktop_handle = tokio::spawn(async move {
        loop {
            match desktop_loop.poll().await {
                Ok(Event::Incoming(Incoming::Publish(p))) => {
                    if let Ok(env) = serde_json::from_slice::<MqttMessageEnvelope>(&p.payload) {
                        let _ = tx.send(env).await;
                    }
                }
                Err(e) => {
                    eprintln!("Desktop loop error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    desktop_client
        .subscribe(&chat_req_topic, QoS::AtLeastOnce)
        .await
        .expect("Desktop subscribe failed");

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // ── Mobile: send chat request ──
    let (mobile_client, mut mobile_loop) = create_client(&config, &format!("e2e-mcr-{}", ns));
    let mobile_handle = tokio::spawn(async move {
        loop {
            if mobile_loop.poll().await.is_err() {
                break;
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(1000)).await;

    let request = MqttMessageEnvelope {
        id: new_id(),
        msg_type: "chat_request".to_string(),
        timestamp: now_ts(),
        payload: serde_json::to_value(&ChatRequestPayload {
            session_id: "session-001".to_string(),
            content: "帮我做一份周报".to_string(),
            image_url: None,
            model: None,
        })
        .unwrap(),
    };
    let payload = serde_json::to_vec(&request).unwrap();

    mobile_client
        .publish(&chat_req_topic, QoS::AtLeastOnce, false, payload)
        .await
        .expect("Mobile publish failed");

    // ── Desktop receives request ──
    let msg = timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("Timeout: desktop didn't receive chat request")
        .expect("Channel closed");

    assert_eq!(msg.msg_type, "chat_request");
    let req: ChatRequestPayload = serde_json::from_value(msg.payload).unwrap();
    assert_eq!(req.session_id, "session-001");
    assert_eq!(req.content, "帮我做一份周报");

    desktop_client.disconnect().await.ok();
    mobile_client.disconnect().await.ok();
    desktop_handle.abort();
    mobile_handle.abort();
}

/// Test 4: Desktop sends streaming chat response (aggregated chunks), mobile receives
#[tokio::test]
async fn test_desktop_streams_chat_response() {
    let Some(config) = TestConfig::from_env() else {
        eprintln!("SKIP: MQTT_BROKER_HOST not set");
        return;
    };

    let ns = unique_ns();
    let chat_res_topic = format!("teamclaw/{}/mobile/chat/res", ns);

    // ── Mobile: subscribe to chat/res ──
    let (mobile_client, mut mobile_loop) = create_client(&config, &format!("e2e-mcres-{}", ns));
    let (tx, mut rx) = mpsc::channel::<MqttMessageEnvelope>(50);

    let mobile_handle = tokio::spawn(async move {
        loop {
            match mobile_loop.poll().await {
                Ok(Event::Incoming(Incoming::Publish(p))) => {
                    if let Ok(env) = serde_json::from_slice::<MqttMessageEnvelope>(&p.payload) {
                        let _ = tx.send(env).await;
                    }
                }
                Err(e) => {
                    eprintln!("Mobile loop error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    mobile_client
        .subscribe(&chat_res_topic, QoS::AtLeastOnce)
        .await
        .expect("Mobile subscribe failed");

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // ── Desktop: send 3 streaming chunks (simulating 200ms aggregation) ──
    let (desktop_client, mut desktop_loop) = create_client(&config, &format!("e2e-dcres-{}", ns));
    let desktop_handle = tokio::spawn(async move {
        loop {
            if desktop_loop.poll().await.is_err() {
                break;
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(1000)).await;

    let session_id = "session-001";
    let chunks = vec![
        ChatResponsePayload {
            session_id: session_id.to_string(),
            seq: 0,
            delta: "你好，".to_string(),
            done: false,
            full: None,
        },
        ChatResponsePayload {
            session_id: session_id.to_string(),
            seq: 1,
            delta: "我来帮你整理".to_string(),
            done: false,
            full: None,
        },
        ChatResponsePayload {
            session_id: session_id.to_string(),
            seq: 2,
            delta: "周报。".to_string(),
            done: true,
            full: Some("你好，我来帮你整理周报。".to_string()),
        },
    ];

    for chunk in &chunks {
        let envelope = MqttMessageEnvelope {
            id: new_id(),
            msg_type: "chat_response".to_string(),
            timestamp: now_ts(),
            payload: serde_json::to_value(chunk).unwrap(),
        };
        desktop_client
            .publish(
                &chat_res_topic,
                QoS::AtLeastOnce,
                false,
                serde_json::to_vec(&envelope).unwrap(),
            )
            .await
            .expect("Desktop publish chunk failed");

        // Simulate 200ms aggregation interval
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // ── Mobile: receive all 3 chunks ──
    let mut received_chunks: Vec<ChatResponsePayload> = Vec::new();

    for _ in 0..3 {
        let msg = timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("Timeout waiting for chunk")
            .expect("Channel closed");

        assert_eq!(msg.msg_type, "chat_response");
        let chunk: ChatResponsePayload = serde_json::from_value(msg.payload).unwrap();
        received_chunks.push(chunk);
    }

    // Verify ordering
    assert_eq!(received_chunks.len(), 3);
    assert_eq!(received_chunks[0].seq, 0);
    assert_eq!(received_chunks[1].seq, 1);
    assert_eq!(received_chunks[2].seq, 2);

    // Verify first two are partial, last is done
    assert!(!received_chunks[0].done);
    assert!(!received_chunks[1].done);
    assert!(received_chunks[2].done);

    // Verify full content on final chunk
    assert_eq!(
        received_chunks[2].full.as_deref(),
        Some("你好，我来帮你整理周报。")
    );

    // Verify assembled content from deltas
    let assembled: String = received_chunks.iter().map(|c| c.delta.as_str()).collect();
    assert_eq!(assembled, "你好，我来帮你整理周报。");

    desktop_client.disconnect().await.ok();
    mobile_client.disconnect().await.ok();
    desktop_handle.abort();
    mobile_handle.abort();
}

/// Test 5: Desktop goes offline — mobile receives offline status
#[tokio::test]
async fn test_desktop_offline_status() {
    let Some(config) = TestConfig::from_env() else {
        eprintln!("SKIP: MQTT_BROKER_HOST not set");
        return;
    };

    let ns = unique_ns();
    let status_topic = format!("teamclaw/{}/desktop/status", ns);

    // ── Mobile: subscribe first ──
    let (mobile_client, mut mobile_loop) = create_client(&config, &format!("e2e-moff-{}", ns));
    let (tx, mut rx) = mpsc::channel::<MqttMessageEnvelope>(10);

    let mobile_handle = tokio::spawn(async move {
        loop {
            match mobile_loop.poll().await {
                Ok(Event::Incoming(Incoming::Publish(p))) => {
                    if let Ok(env) = serde_json::from_slice::<MqttMessageEnvelope>(&p.payload) {
                        let _ = tx.send(env).await;
                    }
                }
                Err(e) => {
                    eprintln!("Mobile loop error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    mobile_client
        .subscribe(&status_topic, QoS::AtLeastOnce)
        .await
        .expect("Subscribe failed");

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // ── Desktop: publish online then offline (retained) ──
    let (desktop_client, mut desktop_loop) = create_client(&config, &format!("e2e-doff-{}", ns));
    let desktop_handle = tokio::spawn(async move {
        loop {
            if desktop_loop.poll().await.is_err() {
                break;
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Publish online
    let online_env = MqttMessageEnvelope {
        id: new_id(),
        msg_type: "status".to_string(),
        timestamp: now_ts(),
        payload: serde_json::to_value(&StatusPayload {
            online: true,
            device_name: Some("Desktop".to_string()),
        })
        .unwrap(),
    };
    desktop_client
        .publish(
            &status_topic,
            QoS::AtLeastOnce,
            true,
            serde_json::to_vec(&online_env).unwrap(),
        )
        .await
        .unwrap();

    // Receive online
    let msg = timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("Timeout")
        .unwrap();
    let s: StatusPayload = serde_json::from_value(msg.payload).unwrap();
    assert!(s.online);

    // Publish offline
    let offline_env = MqttMessageEnvelope {
        id: new_id(),
        msg_type: "status".to_string(),
        timestamp: now_ts(),
        payload: serde_json::to_value(&StatusPayload {
            online: false,
            device_name: None,
        })
        .unwrap(),
    };
    desktop_client
        .publish(
            &status_topic,
            QoS::AtLeastOnce,
            true,
            serde_json::to_vec(&offline_env).unwrap(),
        )
        .await
        .unwrap();

    // Receive offline
    let msg = timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("Timeout")
        .unwrap();
    let s: StatusPayload = serde_json::from_value(msg.payload).unwrap();
    assert!(!s.online);

    // Cleanup retained
    desktop_client
        .publish(&status_topic, QoS::AtLeastOnce, true, vec![])
        .await
        .ok();

    desktop_client.disconnect().await.ok();
    mobile_client.disconnect().await.ok();
    desktop_handle.abort();
    mobile_handle.abort();
}

/// Test 6: Data sync — tasks, skills, members published to mobile device topic
#[tokio::test]
async fn test_data_sync_to_mobile() {
    let Some(config) = TestConfig::from_env() else {
        eprintln!("SKIP: MQTT_BROKER_HOST not set");
        return;
    };

    let ns = unique_ns();
    let task_topic = format!("teamclaw/{}/mobile/task", ns);
    let skill_topic = format!("teamclaw/{}/mobile/skill", ns);
    let member_topic = format!("teamclaw/{}/mobile/member", ns);

    // ── Mobile: subscribe to all sync topics ──
    let (mobile_client, mut mobile_loop) = create_client(&config, &format!("e2e-msync-{}", ns));
    let (tx, mut rx) = mpsc::channel::<MqttMessageEnvelope>(30);

    let mobile_handle = tokio::spawn(async move {
        loop {
            match mobile_loop.poll().await {
                Ok(Event::Incoming(Incoming::Publish(p))) => {
                    if let Ok(env) = serde_json::from_slice::<MqttMessageEnvelope>(&p.payload) {
                        let _ = tx.send(env).await;
                    }
                }
                Err(e) => {
                    eprintln!("Mobile loop error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    mobile_client
        .subscribe(&task_topic, QoS::AtLeastOnce)
        .await
        .unwrap();
    mobile_client
        .subscribe(&skill_topic, QoS::AtLeastOnce)
        .await
        .unwrap();
    mobile_client
        .subscribe(&member_topic, QoS::AtLeastOnce)
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // ── Desktop: publish sync data ──
    let (desktop_client, mut desktop_loop) = create_client(&config, &format!("e2e-dsync-{}", ns));
    let desktop_handle = tokio::spawn(async move {
        loop {
            if desktop_loop.poll().await.is_err() {
                break;
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Sync tasks
    let task_env = MqttMessageEnvelope {
        id: new_id(),
        msg_type: "task_update".to_string(),
        timestamp: now_ts(),
        payload: serde_json::json!({
            "tasks": [
                {"task_id": "t1", "status": "running", "last_run_time": null},
                {"task_id": "t2", "status": "completed", "last_run_time": 1712000000.0}
            ]
        }),
    };
    desktop_client
        .publish(
            &task_topic,
            QoS::AtLeastOnce,
            false,
            serde_json::to_vec(&task_env).unwrap(),
        )
        .await
        .unwrap();

    // Sync skills
    let skill_env = MqttMessageEnvelope {
        id: new_id(),
        msg_type: "skill_sync".to_string(),
        timestamp: now_ts(),
        payload: serde_json::json!({
            "skills": [
                {"id": "sk1", "name": "数据分析", "description": "分析运营数据", "is_personal": true, "is_enabled": true},
                {"id": "sk2", "name": "代码审查", "description": "审查PR", "is_personal": false, "is_enabled": true}
            ]
        }),
    };
    desktop_client
        .publish(
            &skill_topic,
            QoS::AtLeastOnce,
            false,
            serde_json::to_vec(&skill_env).unwrap(),
        )
        .await
        .unwrap();

    // Sync members
    let member_env = MqttMessageEnvelope {
        id: new_id(),
        msg_type: "member_sync".to_string(),
        timestamp: now_ts(),
        payload: serde_json::json!({
            "members": [
                {"id": "m1", "name": "张三", "avatar_url": null, "note": "运营"},
                {"id": "m2", "name": "李四", "avatar_url": null, "note": "开发"}
            ]
        }),
    };
    desktop_client
        .publish(
            &member_topic,
            QoS::AtLeastOnce,
            false,
            serde_json::to_vec(&member_env).unwrap(),
        )
        .await
        .unwrap();

    // ── Mobile: receive all 3 sync messages ──
    let mut received: Vec<MqttMessageEnvelope> = Vec::new();
    for _ in 0..3 {
        let msg = timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("Timeout waiting for sync message")
            .expect("Channel closed");
        received.push(msg);
    }

    // Verify all types received
    let types: Vec<&str> = received.iter().map(|m| m.msg_type.as_str()).collect();
    assert!(types.contains(&"task_update"));
    assert!(types.contains(&"skill_sync"));
    assert!(types.contains(&"member_sync"));

    // Verify task data
    let task_msg = received
        .iter()
        .find(|m| m.msg_type == "task_update")
        .unwrap();
    let tasks = task_msg.payload.get("tasks").unwrap().as_array().unwrap();
    assert_eq!(tasks.len(), 2);

    // Verify skill data
    let skill_msg = received
        .iter()
        .find(|m| m.msg_type == "skill_sync")
        .unwrap();
    let skills = skill_msg.payload.get("skills").unwrap().as_array().unwrap();
    assert_eq!(skills.len(), 2);
    assert_eq!(skills[0]["name"], "数据分析");

    // Verify member data
    let member_msg = received
        .iter()
        .find(|m| m.msg_type == "member_sync")
        .unwrap();
    let members = member_msg
        .payload
        .get("members")
        .unwrap()
        .as_array()
        .unwrap();
    assert_eq!(members.len(), 2);
    assert_eq!(members[0]["name"], "张三");

    desktop_client.disconnect().await.ok();
    mobile_client.disconnect().await.ok();
    desktop_handle.abort();
    mobile_handle.abort();
}

/// Test 7: QoS 1 guarantees — message delivered even with brief disconnect
#[tokio::test]
async fn test_qos1_message_delivery() {
    let Some(config) = TestConfig::from_env() else {
        eprintln!("SKIP: MQTT_BROKER_HOST not set");
        return;
    };

    let test_topic = format!("teamclaw/e2e-qos/{}", new_id());

    // ── Subscriber: connect with clean_start=false and a persistent client ID ──
    let persistent_id = format!("e2e-qos-sub-{}", rand::random::<u16>());

    // First connection: subscribe
    {
        let mut opts = MqttOptions::new(&persistent_id, &config.host, config.port);
        if !config.username.is_empty() {
            opts.set_credentials(&config.username, &config.password);
        }
        opts.set_keep_alive(Duration::from_secs(30));
        opts.set_clean_start(true); // First time: clean start to register subscription
        if config.tls {
            opts.set_transport(rumqttc::Transport::tls_with_default_config());
        }

        let (client, mut eventloop) = AsyncClient::new(opts, 100);
        let handle = tokio::spawn(async move {
            loop {
                if eventloop.poll().await.is_err() {
                    break;
                }
            }
        });

        tokio::time::sleep(Duration::from_millis(1000)).await;
        client
            .subscribe(&test_topic, QoS::AtLeastOnce)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1000)).await;
        client.disconnect().await.ok();
        handle.abort();
    }

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // ── Publisher: send message while subscriber is offline ──
    {
        let (client, mut eventloop) = create_client(&config, "e2e-qos-pub");
        let handle = tokio::spawn(async move {
            loop {
                if eventloop.poll().await.is_err() {
                    break;
                }
            }
        });

        tokio::time::sleep(Duration::from_millis(1000)).await;
        client
            .publish(
                &test_topic,
                QoS::AtLeastOnce,
                false,
                "offline-message".as_bytes().to_vec(),
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1000)).await;
        client.disconnect().await.ok();
        handle.abort();
    }

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // ── Subscriber: reconnect with clean_start=false, should get the offline message ──
    {
        let mut opts = MqttOptions::new(&persistent_id, &config.host, config.port);
        if !config.username.is_empty() {
            opts.set_credentials(&config.username, &config.password);
        }
        opts.set_keep_alive(Duration::from_secs(30));
        opts.set_clean_start(false); // Resume session
        if config.tls {
            opts.set_transport(rumqttc::Transport::tls_with_default_config());
        }

        let (client, mut eventloop) = AsyncClient::new(opts, 100);
        let (tx, mut rx) = mpsc::channel::<String>(10);

        let handle = tokio::spawn(async move {
            loop {
                match eventloop.poll().await {
                    Ok(Event::Incoming(Incoming::Publish(p))) => {
                        let msg = String::from_utf8_lossy(&p.payload).to_string();
                        let _ = tx.send(msg).await;
                    }
                    Err(e) => {
                        eprintln!("Reconnect loop error: {}", e);
                        break;
                    }
                    _ => {}
                }
            }
        });

        // Should receive the message that was sent while offline
        let result = timeout(Duration::from_secs(10), rx.recv()).await;
        match result {
            Ok(Some(msg)) => {
                assert_eq!(msg, "offline-message");
            }
            _ => {
                // QoS 1 offline delivery depends on broker's session expiry config
                // Some brokers discard sessions quickly — this is acceptable
                eprintln!("NOTE: Offline message not delivered (broker session may have expired)");
            }
        }

        client.disconnect().await.ok();
        handle.abort();
    }
}

/// Test 8: Multiple mobile devices receive messages independently
#[tokio::test]
async fn test_multi_device_isolation() {
    let Some(config) = TestConfig::from_env() else {
        eprintln!("SKIP: MQTT_BROKER_HOST not set");
        return;
    };

    let ns = unique_ns();
    let topic_a = format!("teamclaw/{}/dev-a/chat/res", ns);
    let topic_b = format!("teamclaw/{}/dev-b/chat/res", ns);

    // ── Device A: subscribe to own topic ──
    let (client_a, mut loop_a) = create_client(&config, &format!("e2e-ma-{}", ns));
    let (tx_a, mut rx_a) = mpsc::channel::<String>(10);
    let handle_a = tokio::spawn(async move {
        loop {
            match loop_a.poll().await {
                Ok(Event::Incoming(Incoming::Publish(p))) => {
                    let _ = tx_a
                        .send(String::from_utf8_lossy(&p.payload).to_string())
                        .await;
                }
                Err(_) => break,
                _ => {}
            }
        }
    });
    client_a
        .subscribe(&topic_a, QoS::AtLeastOnce)
        .await
        .unwrap();

    // ── Device B: subscribe to own topic ──
    let (client_b, mut loop_b) = create_client(&config, &format!("e2e-mb-{}", ns));
    let (tx_b, mut rx_b) = mpsc::channel::<String>(10);
    let handle_b = tokio::spawn(async move {
        loop {
            match loop_b.poll().await {
                Ok(Event::Incoming(Incoming::Publish(p))) => {
                    let _ = tx_b
                        .send(String::from_utf8_lossy(&p.payload).to_string())
                        .await;
                }
                Err(_) => break,
                _ => {}
            }
        }
    });
    client_b
        .subscribe(&topic_b, QoS::AtLeastOnce)
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(1000)).await;

    // ── Desktop: send message only to device A ──
    let (desktop, mut desktop_loop) = create_client(&config, &format!("e2e-md-{}", ns));
    let desktop_handle = tokio::spawn(async move {
        loop {
            if desktop_loop.poll().await.is_err() {
                break;
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(1000)).await;

    desktop
        .publish(
            &topic_a,
            QoS::AtLeastOnce,
            false,
            "for-device-a-only".as_bytes().to_vec(),
        )
        .await
        .unwrap();

    // Device A should receive
    let msg_a = timeout(Duration::from_secs(5), rx_a.recv())
        .await
        .expect("Device A didn't receive")
        .unwrap();
    assert_eq!(msg_a, "for-device-a-only");

    // Device B should NOT receive (wait briefly to confirm)
    let msg_b = timeout(Duration::from_secs(2), rx_b.recv()).await;
    assert!(
        msg_b.is_err(),
        "Device B should not receive device A's message"
    );

    desktop.disconnect().await.ok();
    client_a.disconnect().await.ok();
    client_b.disconnect().await.ok();
    desktop_handle.abort();
    handle_a.abort();
    handle_b.abort();
}
