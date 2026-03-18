use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn default_true() -> bool {
    true
}

/// KOOK DM configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KookDmConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_policy")]
    pub policy: String,
    #[serde(default)]
    pub allow_from: Vec<String>,
}

fn default_policy() -> String {
    "open".to_string()
}

impl Default for KookDmConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            policy: "open".to_string(),
            allow_from: Vec::new(),
        }
    }
}

/// KOOK channel rule configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KookChannelRule {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default = "default_true")]
    pub require_mention: bool,
    #[serde(default)]
    pub allowed_users: Vec<String>,
}

impl Default for KookChannelRule {
    fn default() -> Self {
        Self {
            enabled: true,
            session_id: None,
            require_mention: true,
            allowed_users: Vec::new(),
        }
    }
}

/// KOOK guild (server) configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KookGuildConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub channels: HashMap<String, KookChannelRule>,
}

impl Default for KookGuildConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            slug: None,
            channels: HashMap::new(),
        }
    }
}

/// KOOK channel configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KookConfig {
    /// Whether KOOK integration is enabled
    #[serde(default)]
    pub enabled: bool,

    /// KOOK bot token (from developer portal)
    #[serde(default)]
    pub token: String,

    /// Direct message configuration
    #[serde(default)]
    pub dm: KookDmConfig,

    /// Guild (server) configurations
    #[serde(default)]
    pub guilds: HashMap<String, KookGuildConfig>,
}

impl Default for KookConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            token: String::new(),
            dm: KookDmConfig::default(),
            guilds: HashMap::new(),
        }
    }
}

/// KOOK gateway status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum KookGatewayStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

impl Default for KookGatewayStatus {
    fn default() -> Self {
        Self::Disconnected
    }
}

/// KOOK gateway status response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KookGatewayStatusResponse {
    pub status: KookGatewayStatus,
    pub error_message: Option<String>,
    pub bot_username: Option<String>,
    pub connected_guilds: Vec<String>,
}

impl Default for KookGatewayStatusResponse {
    fn default() -> Self {
        Self {
            status: KookGatewayStatus::Disconnected,
            error_message: None,
            bot_username: None,
            connected_guilds: Vec::new(),
        }
    }
}
