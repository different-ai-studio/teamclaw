use crate::mqtt::{ClientConfig, MqttBus, MqttClient};
use rumqttc::QoS;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Debug, Serialize, Deserialize)]
pub struct MqttStatus {
    pub connected: bool,
    pub subscribed_topics: Vec<String>,
}

#[tauri::command]
pub async fn mqtt_connect(
    app: AppHandle,
    bus: State<'_, MqttBus>,
    broker_url: Option<String>,
    broker_host: String,
    broker_port: u16,
    username: String,
    password: String,
    client_id: String,
    team_id: String,
    use_tls: bool,
) -> Result<(), String> {
    let cfg = ClientConfig {
        broker_url,
        broker_host,
        broker_port,
        client_id,
        username,
        password,
        team_id,
        use_tls,
    };
    let client = MqttClient::connect(cfg).map_err(|e| e.to_string())?;
    let generation = bus.bump_generation();
    // Reset to false until the event loop observes a CONNACK. Without this,
    // a stale `true` from a previous session could leak into the UI between
    // `mqtt_connect` returning and the broker's CONNACK arriving.
    bus.set_connected(false);
    let previous_client = {
        let mut client_guard = bus.client.lock().await;
        client_guard.replace(client)
    };
    bus.subscribed.lock().await.clear();
    if let Some(previous_client) = previous_client {
        let _ = previous_client.client.disconnect().await;
    }

    let bus_arc = (*bus).clone();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::mqtt::client::run_event_loop(bus_arc, app_clone, generation).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn mqtt_subscribe(bus: State<'_, MqttBus>, topic: String) -> Result<(), String> {
    let client_guard = bus.client.lock().await;
    let client = client_guard.as_ref().ok_or("mqtt not connected")?;
    client
        .client
        .subscribe(&topic, QoS::AtLeastOnce)
        .await
        .map_err(|e| e.to_string())?;
    drop(client_guard);
    bus.subscribed.lock().await.insert(topic);
    Ok(())
}

#[tauri::command]
pub async fn mqtt_unsubscribe(bus: State<'_, MqttBus>, topic: String) -> Result<(), String> {
    let client_guard = bus.client.lock().await;
    let client = client_guard.as_ref().ok_or("mqtt not connected")?;
    client
        .client
        .unsubscribe(&topic)
        .await
        .map_err(|e| e.to_string())?;
    drop(client_guard);
    bus.subscribed.lock().await.remove(&topic);
    Ok(())
}

#[tauri::command]
pub async fn mqtt_publish(
    bus: State<'_, MqttBus>,
    topic: String,
    bytes: Vec<u8>,
    retain: bool,
) -> Result<(), String> {
    let client_guard = bus.client.lock().await;
    let client = client_guard.as_ref().ok_or("mqtt not connected")?;
    client
        .client
        .publish(&topic, QoS::AtLeastOnce, retain, bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mqtt_status(bus: State<'_, MqttBus>) -> Result<MqttStatus, String> {
    // Honest connection check: the bus's `connected` flag is only true after
    // the event loop has observed a CONNACK from the broker and not since seen
    // a network error or DISCONNECT. The previous heuristic (`client.is_some()`)
    // reported "connected" even when the TCP/TLS connection had died silently.
    let connected = bus.is_connected();
    let subscribed_topics: Vec<String> = bus.subscribed.lock().await.iter().cloned().collect();
    Ok(MqttStatus {
        connected,
        subscribed_topics,
    })
}
