use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Feishu channel configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuConfig {
    /// Whether Feishu integration is enabled
    #[serde(default)]
    pub enabled: bool,

    /// Feishu app ID
    #[serde(default)]
    pub app_id: String,

    /// Feishu app secret
    #[serde(default)]
    pub app_secret: String,

    /// Chat configurations (chat_id -> ChatConfig)
    #[serde(default)]
    pub chats: HashMap<String, FeishuChatConfig>,
}

impl Default for FeishuConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            app_id: String::new(),
            app_secret: String::new(),
            chats: HashMap::new(),
        }
    }
}

/// Feishu chat-level configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuChatConfig {
    /// Whether this chat is allowed
    #[serde(default)]
    pub allow: bool,

    /// Allowed user open_ids (empty means all)
    #[serde(default)]
    pub users: Vec<String>,
}

impl Default for FeishuChatConfig {
    fn default() -> Self {
        Self {
            allow: false,
            users: Vec::new(),
        }
    }
}

/// Feishu gateway status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FeishuGatewayStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

impl Default for FeishuGatewayStatus {
    fn default() -> Self {
        Self::Disconnected
    }
}

/// Feishu gateway status response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuGatewayStatusResponse {
    pub status: FeishuGatewayStatus,
    pub error_message: Option<String>,
    pub app_id: Option<String>,
}

impl Default for FeishuGatewayStatusResponse {
    fn default() -> Self {
        Self {
            status: FeishuGatewayStatus::Disconnected,
            error_message: None,
            app_id: None,
        }
    }
}
