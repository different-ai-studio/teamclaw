use serde::{Deserialize, Serialize};

/// Email provider type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EmailProvider {
    #[default]
    Gmail,
    Custom,
}

/// Email channel configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailConfig {
    /// Whether email integration is enabled
    #[serde(default)]
    pub enabled: bool,

    /// Provider type: gmail or custom
    #[serde(default)]
    pub provider: EmailProvider,

    // ---- Gmail OAuth2 fields ----
    /// Google Cloud OAuth2 client ID
    #[serde(default)]
    pub gmail_client_id: String,

    /// Google Cloud OAuth2 client secret
    #[serde(default)]
    pub gmail_client_secret: String,

    /// User's Gmail address (used for XOAUTH2 auth)
    #[serde(default)]
    pub gmail_email: String,

    /// Whether Gmail OAuth2 authorization has been completed
    #[serde(default)]
    pub gmail_authorized: bool,

    // ---- Custom IMAP/SMTP fields ----
    /// IMAP server hostname
    #[serde(default)]
    pub imap_server: String,

    /// IMAP server port (default 993 for SSL)
    #[serde(default = "default_imap_port")]
    pub imap_port: u16,

    /// SMTP server hostname
    #[serde(default)]
    pub smtp_server: String,

    /// SMTP server port (default 587 for STARTTLS)
    #[serde(default = "default_smtp_port")]
    pub smtp_port: u16,

    /// Username for IMAP/SMTP authentication
    #[serde(default)]
    pub username: String,

    /// Password or app password for IMAP/SMTP authentication
    #[serde(default)]
    pub password: String,

    // ---- Filter settings ----
    /// Allowed sender email addresses or patterns (e.g., *@company.com)
    #[serde(default)]
    pub allowed_senders: Vec<String>,

    /// Gmail labels to monitor (Gmail only, empty means INBOX only)
    #[serde(default)]
    pub labels: Vec<String>,

    /// Whether to reply to all new emails when no filters are configured
    #[serde(default)]
    pub reply_all_new: bool,

    /// Optional plus-alias local part suffix.
    /// Example: if base mailbox is teamclaw@ai.com and alias is "agen",
    /// only messages addressed to teamclaw+agen@ai.com are processed.
    /// If empty, alias filtering is skipped and only Allowed Senders
    /// controls which emails are processed.
    #[serde(default)]
    pub recipient_alias: String,

    /// Display name shown in the From header of reply emails.
    /// e.g., "TeamClaw Agent" will appear as: "TeamClaw Agent <user+agent@gmail.com>"
    /// If empty, no display name is set (only the email address is shown).
    #[serde(default = "default_display_name")]
    pub display_name: String,
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: EmailProvider::Gmail,
            gmail_client_id: String::new(),
            gmail_client_secret: String::new(),
            gmail_email: String::new(),
            gmail_authorized: false,
            imap_server: String::new(),
            imap_port: 993,
            smtp_server: String::new(),
            smtp_port: 465,
            username: String::new(),
            password: String::new(),
            allowed_senders: Vec::new(),
            labels: Vec::new(),
            reply_all_new: false,
            recipient_alias: String::new(),
            display_name: default_display_name(),
        }
    }
}

/// Email gateway status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EmailGatewayStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    Error,
}

/// Email gateway status response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailGatewayStatusResponse {
    pub status: EmailGatewayStatus,
    pub error_message: Option<String>,
    pub email: Option<String>,
}

impl Default for EmailGatewayStatusResponse {
    fn default() -> Self {
        Self {
            status: EmailGatewayStatus::Disconnected,
            error_message: None,
            email: None,
        }
    }
}

fn default_imap_port() -> u16 {
    993
}

fn default_smtp_port() -> u16 {
    465
}

fn default_display_name() -> String {
    "TeamClaw Agent".to_string()
}
