use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct MqttStatus {
    pub connected: bool,
    pub subscribed_sessions: Vec<String>,
}

#[tauri::command]
pub async fn mqtt_subscribe(_app: AppHandle, _session_id: String) -> Result<(), String> {
    Err("not_implemented".into())
}

#[tauri::command]
pub async fn mqtt_publish(
    _app: AppHandle,
    _session_id: String,
    _envelope_bytes: Vec<u8>,
) -> Result<(), String> {
    Err("not_implemented".into())
}

#[tauri::command]
pub async fn mqtt_status(_app: AppHandle) -> Result<MqttStatus, String> {
    Ok(MqttStatus { connected: false, subscribed_sessions: vec![] })
}
