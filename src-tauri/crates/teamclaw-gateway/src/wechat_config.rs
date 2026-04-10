use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeChatConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bot_token: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default = "default_ilink_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub sync_buf: Option<String>,
    #[serde(default)]
    pub context_tokens: std::collections::HashMap<String, String>,
}

pub fn default_ilink_base_url() -> String {
    "https://ilinkai.weixin.qq.com".to_string()
}

impl Default for WeChatConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bot_token: String::new(),
            account_id: String::new(),
            base_url: default_ilink_base_url(),
            sync_buf: None,
            context_tokens: std::collections::HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WeChatGatewayStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

impl Default for WeChatGatewayStatus {
    fn default() -> Self {
        Self::Disconnected
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeChatGatewayStatusResponse {
    pub status: WeChatGatewayStatus,
    pub error_message: Option<String>,
    pub account_id: Option<String>,
}

impl Default for WeChatGatewayStatusResponse {
    fn default() -> Self {
        Self {
            status: WeChatGatewayStatus::Disconnected,
            error_message: None,
            account_id: None,
        }
    }
}

/// QR login response from ilink/bot/get_bot_qrcode
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeChatQrLoginResponse {
    pub qrcode: String,
    #[serde(default, alias = "qrcode_img_content")]
    pub qrcode_img_content: Option<String>,
}

/// QR status response from ilink/bot/get_qrcode_status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeChatQrStatusResponse {
    pub status: String, // "wait" | "scaned" | "confirmed" | "expired"
    #[serde(default, alias = "bot_token")]
    pub bot_token: Option<String>,
    #[serde(default, alias = "ilink_bot_id")]
    pub ilink_bot_id: Option<String>,
    #[serde(default)]
    pub baseurl: Option<String>,
    #[serde(default, alias = "ilink_user_id")]
    pub ilink_user_id: Option<String>,
}
