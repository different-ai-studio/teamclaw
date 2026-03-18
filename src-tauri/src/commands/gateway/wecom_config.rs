use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeComConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bot_id: String,
    #[serde(default)]
    pub secret: String,
    #[serde(default)]
    pub encoding_aes_key: Option<String>,
}

impl Default for WeComConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bot_id: String::new(),
            secret: String::new(),
            encoding_aes_key: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WeComGatewayStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeComGatewayStatusResponse {
    pub status: WeComGatewayStatus,
    pub error_message: Option<String>,
    pub bot_id: Option<String>,
}

impl Default for WeComGatewayStatusResponse {
    fn default() -> Self {
        Self {
            status: WeComGatewayStatus::Disconnected,
            error_message: None,
            bot_id: None,
        }
    }
}
