use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// SeaTalk channel configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeaTalkConfig {
    #[serde(default)]
    pub enabled: bool,

    /// SeaTalk Open Platform App ID
    #[serde(default)]
    pub app_id: String,

    /// SeaTalk Open Platform App Secret
    #[serde(default)]
    pub app_secret: String,

    /// Gateway mode: `websocket` (default) or `webhook`
    #[serde(default = "default_mode")]
    pub mode: String,

    /// Signing secret for webhook mode event verification
    #[serde(default)]
    pub signing_secret: String,

    /// HTTP port for webhook mode
    #[serde(default = "default_webhook_port")]
    pub webhook_port: u16,

    /// HTTP path for webhook mode
    #[serde(default = "default_webhook_path")]
    pub webhook_path: String,

    /// DM access policy: `open` | `allowlist`
    #[serde(default = "default_dm_policy")]
    pub dm_policy: String,

    /// Allowed DM senders (employee codes or emails). Use `*` for open policy.
    #[serde(default)]
    pub allow_from: Vec<String>,

    /// Group access policy: `disabled` | `allowlist` | `open`
    ///
    /// Default `open` so @bot mentions work after the bot is added to a group.
    #[serde(default = "default_group_policy")]
    pub group_policy: String,

    /// Allowed group IDs when `groupPolicy = allowlist`
    #[serde(default)]
    pub group_allow_from: Vec<String>,

    /// Optional per-group sender allowlist (employee codes or emails)
    #[serde(default)]
    pub group_sender_allow_from: Vec<String>,

    /// Route each group thread to its own agent session
    #[serde(default = "default_true")]
    pub group_thread_session: bool,

    /// Route each DM thread to its own agent session
    #[serde(default = "default_true")]
    pub dm_thread_session: bool,

    /// Per-group overrides (group_id -> config)
    #[serde(default)]
    pub groups: HashMap<String, SeaTalkGroupConfig>,
}

impl Default for SeaTalkConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            app_id: String::new(),
            app_secret: String::new(),
            mode: default_mode(),
            signing_secret: String::new(),
            webhook_port: default_webhook_port(),
            webhook_path: default_webhook_path(),
            dm_policy: default_dm_policy(),
            allow_from: Vec::new(),
            group_policy: default_group_policy(),
            group_allow_from: Vec::new(),
            group_sender_allow_from: Vec::new(),
            group_thread_session: true,
            dm_thread_session: true,
            groups: HashMap::new(),
        }
    }
}

/// Per-group configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeaTalkGroupConfig {
    #[serde(default)]
    pub allow: bool,

    #[serde(default)]
    pub users: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SeaTalkGatewayStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeaTalkGatewayStatusResponse {
    pub status: SeaTalkGatewayStatus,
    pub error_message: Option<String>,
    pub app_id: Option<String>,
}

impl Default for SeaTalkGatewayStatusResponse {
    fn default() -> Self {
        Self {
            status: SeaTalkGatewayStatus::Disconnected,
            error_message: None,
            app_id: None,
        }
    }
}

fn default_mode() -> String {
    "websocket".to_string()
}

fn default_webhook_port() -> u16 {
    8080
}

fn default_webhook_path() -> String {
    "/callback".to_string()
}

fn default_dm_policy() -> String {
    // Open by default so 1:1 chats work without an allowlist UI pass.
    "open".to_string()
}

fn default_group_policy() -> String {
    // Open by default so @bot in any group the bot joins is answered.
    "open".to_string()
}

fn default_true() -> bool {
    true
}
