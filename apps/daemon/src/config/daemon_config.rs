use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonConfig {
    pub device: DeviceConfig,
    pub mqtt: MqttConfig,
    #[serde(default)]
    pub agents: AgentsConfig,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub channels: ChannelsConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceConfig {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttConfig {
    pub broker_url: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct AgentsConfig {
    #[serde(default)]
    pub claude_code: Option<ClaudeCodeConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCodeConfig {
    #[serde(default = "default_claude_binary")]
    pub binary: String,
    #[serde(default)]
    pub default_flags: Vec<String>,
}

fn default_claude_binary() -> String {
    "claude".into()
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ChannelsConfig {
    #[serde(default)]
    pub discord: Option<DiscordChannel>,
    #[serde(default)]
    pub wecom: Option<WeComChannel>,
    #[serde(default)]
    pub feishu: Option<FeishuChannel>,
    #[serde(default)]
    pub kook: Option<KookChannel>,
    #[serde(default)]
    pub wechat: Option<WeChatChannel>,
    #[serde(default)]
    pub email: Option<EmailChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordChannel {
    pub enabled: bool,
    pub bot_token: String,
    #[serde(default)]
    pub default_username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComChannel {
    pub enabled: bool,
    /// WeCom bot id (QR-bound bot mode used by `teamclaw_gateway::wecom`).
    pub bot_id: String,
    pub secret: String,
    #[serde(default)]
    pub encoding_aes_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeishuChannel {
    pub enabled: bool,
    pub app_id: String,
    pub app_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KookChannel {
    pub enabled: bool,
    pub bot_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeChatChannel {
    pub enabled: bool,
    pub ilink_account: String,
    pub ilink_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailChannel {
    pub enabled: bool,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_user: String,
    pub imap_pass: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_pass: String,
    #[serde(default)]
    pub allowed_senders: Vec<String>,
}

impl DaemonConfig {
    pub fn config_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("amux")
    }

    pub fn default_path() -> PathBuf {
        Self::config_dir().join("daemon.toml")
    }

    pub fn load(path: &Path) -> crate::error::Result<Self> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            crate::error::AmuxError::Config(format!("read {}: {}", path.display(), e))
        })?;
        toml::from_str(&content).map_err(|e| {
            crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
        })
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn pid_path() -> PathBuf {
        Self::config_dir().join("amuxd.pid")
    }

    pub fn sock_path() -> PathBuf {
        Self::config_dir().join("amuxd.sock")
    }
}

#[cfg(test)]
mod channels_tests {
    use super::*;
    #[test]
    fn channels_roundtrip_wecom() {
        let toml_src = r#"
[device]
id = "d1"
name = "Mac"

[mqtt]
broker_url = "tcp://localhost:1883"

[channels.wecom]
enabled = true
bot_id = "b1"
secret = "s"
encoding_aes_key = "k"
"#;
        let cfg: DaemonConfig = toml::from_str(toml_src).unwrap();
        assert!(cfg.channels.wecom.is_some());
        assert_eq!(cfg.channels.wecom.as_ref().unwrap().bot_id, "b1");
    }
}
