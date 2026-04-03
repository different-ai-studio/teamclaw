use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::email_config::EmailConfig;
use super::feishu_config::FeishuConfig;
use super::kook_config::KookConfig;
use super::wechat_config::WeChatConfig;
use super::wecom_config::WeComConfig;

/// Root channels configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChannelsConfig {
    pub discord: Option<DiscordConfig>,
    pub feishu: Option<FeishuConfig>,
    pub email: Option<EmailConfig>,
    pub kook: Option<KookConfig>,
    pub wechat: Option<WeChatConfig>,
    pub wecom: Option<WeComConfig>,
    pub mqtt: Option<super::mqtt_config::MqttConfig>,
}

/// Discord channel configuration (mirrors OpenClaw structure)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordConfig {
    /// Whether Discord integration is enabled
    #[serde(default)]
    pub enabled: bool,

    /// Discord bot token
    #[serde(default)]
    pub token: String,

    /// Direct message configuration
    #[serde(default)]
    pub dm: DmConfig,

    /// Guild (server) configurations
    #[serde(default)]
    pub guilds: HashMap<String, GuildConfig>,

    /// Retry configuration for API calls
    #[serde(default)]
    pub retry: Option<RetryConfig>,
}

impl Default for DiscordConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            token: String::new(),
            dm: DmConfig::default(),
            guilds: HashMap::new(),
            retry: None,
        }
    }
}

/// Direct message configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmConfig {
    /// Whether DM is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Access policy: "open" | "allowlist"
    #[serde(default = "default_policy")]
    pub policy: String,

    /// List of allowed user IDs or names
    #[serde(default)]
    pub allow_from: Vec<String>,

    /// Whether group DMs are enabled
    #[serde(default)]
    pub group_enabled: bool,

    /// Allowed group DM channels
    #[serde(default)]
    pub group_channels: Vec<String>,
}

impl Default for DmConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            policy: "allowlist".to_string(),
            allow_from: Vec::new(),
            group_enabled: false,
            group_channels: Vec::new(),
        }
    }
}

/// Guild (server) configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuildConfig {
    /// Optional friendly slug for the guild
    #[serde(default)]
    pub slug: Option<String>,

    /// Whether @mention is required to trigger the bot
    #[serde(default = "default_true")]
    pub require_mention: bool,

    /// Allowed users in this guild (IDs or names)
    #[serde(default)]
    pub users: Vec<String>,

    /// Channel configurations
    #[serde(default)]
    pub channels: HashMap<String, ChannelRule>,
}

impl Default for GuildConfig {
    fn default() -> Self {
        Self {
            slug: None,
            require_mention: true,
            users: Vec::new(),
            channels: HashMap::new(),
        }
    }
}

/// Channel-specific rules
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRule {
    /// Whether this channel is allowed
    #[serde(default, alias = "enabled")]
    pub allow: bool,

    /// Whether @mention is required in this channel
    #[serde(default)]
    pub require_mention: Option<bool>,

    /// Allowed users in this specific channel
    #[serde(default)]
    pub users: Vec<String>,

    /// Optional system prompt for this channel
    #[serde(default)]
    pub system_prompt: Option<String>,
}

impl Default for ChannelRule {
    fn default() -> Self {
        Self {
            allow: false,
            require_mention: None,
            users: Vec::new(),
            system_prompt: None,
        }
    }
}

/// Retry configuration for Discord API calls
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryConfig {
    /// Number of retry attempts
    #[serde(default = "default_retry_attempts")]
    pub attempts: u32,

    /// Minimum delay between retries in milliseconds
    #[serde(default = "default_min_delay")]
    pub min_delay_ms: u64,

    /// Maximum delay between retries in milliseconds
    #[serde(default = "default_max_delay")]
    pub max_delay_ms: u64,

    /// Jitter factor (0.0 - 1.0)
    #[serde(default = "default_jitter")]
    pub jitter: f64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            attempts: 3,
            min_delay_ms: 500,
            max_delay_ms: 30000,
            jitter: 0.1,
        }
    }
}

/// Gateway status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GatewayStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

impl Default for GatewayStatus {
    fn default() -> Self {
        Self::Disconnected
    }
}

/// Gateway status response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatusResponse {
    pub status: GatewayStatus,
    pub discord_connected: bool,
    pub error_message: Option<String>,
    pub connected_guilds: Vec<String>,
    pub bot_username: Option<String>,
}

impl Default for GatewayStatusResponse {
    fn default() -> Self {
        Self {
            status: GatewayStatus::Disconnected,
            discord_connected: false,
            error_message: None,
            connected_guilds: Vec::new(),
            bot_username: None,
        }
    }
}

// Default value functions for serde
fn default_true() -> bool {
    true
}

fn default_policy() -> String {
    "allowlist".to_string()
}

fn default_retry_attempts() -> u32 {
    3
}

fn default_min_delay() -> u64 {
    500
}

fn default_max_delay() -> u64 {
    30000
}

fn default_jitter() -> f64 {
    0.1
}
