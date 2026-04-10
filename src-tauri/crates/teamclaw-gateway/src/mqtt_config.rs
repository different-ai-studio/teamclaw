use serde::{Deserialize, Serialize};

/// MQTT relay configuration stored in .teamclaw/teamclaw.json
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MqttConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub broker_host: String,
    #[serde(default = "default_broker_port")]
    pub broker_port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub team_id: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub paired_devices: Vec<PairedDevice>,
}

fn default_broker_port() -> u16 {
    8883
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub device_id: String,
    pub device_name: String,
    pub mqtt_username: String,
    pub mqtt_password: String,
    pub paired_at: u64,
}

#[derive(Debug, Clone)]
pub struct PairingSession {
    pub code: String,
    pub created_at: std::time::Instant,
    pub expires_in: std::time::Duration,
}

impl PairingSession {
    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() > self.expires_in
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttRelayStatus {
    pub connected: bool,
    pub broker_host: Option<String>,
    pub paired_device_count: usize,
    pub error_message: Option<String>,
}
