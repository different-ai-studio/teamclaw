use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
pub struct DaemonConfig {
    pub device: DeviceConfig,
    pub mqtt: MqttConfig,
    #[serde(default)]
    pub agents: AgentsConfig,
    #[serde(default)]
    pub team_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeviceConfig {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MqttConfig {
    pub broker_url: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AgentsConfig {
    #[serde(default)]
    pub claude_code: Option<ClaudeCodeConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClaudeCodeConfig {
    #[serde(default = "default_claude_binary")]
    pub binary: String,
    #[serde(default)]
    pub default_flags: Vec<String>,
}

fn default_claude_binary() -> String {
    "claude".into()
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
