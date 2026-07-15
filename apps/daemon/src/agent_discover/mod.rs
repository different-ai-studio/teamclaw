//! Auto-discover agent backends on the host and merge into `daemon.toml`.
//!
//! Policy (option 3): probe opencode, claude-code, and codex; write every
//! backend that is found but not yet configured. Never overwrite existing
//! `[agents.*]` sections. Cloud `default_agent_type` is always `opencode` when
//! opencode is among the supported backends.

use std::path::Path;

use tracing::info;

use crate::config::{AgentBackendConfig, DaemonConfig};

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DiscoveredAgent {
    pub binary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DiscoverReport {
    pub changed: bool,
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opencode: Option<DiscoveredAgent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_code: Option<DiscoveredAgent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex: Option<DiscoveredAgent>,
}

impl DiscoverReport {
    fn skipped() -> Self {
        Self {
            skipped: true,
            ..Default::default()
        }
    }
}

/// Probe the host and fill missing `[agents.*]` entries on `config` in memory.
pub fn discover_and_merge(config: &mut DaemonConfig) -> DiscoverReport {
    if auto_discover_disabled(config) {
        return DiscoverReport::skipped();
    }

    let mut report = DiscoverReport::default();

    if config.agents.opencode.is_none() {
        if let Some((binary, version)) = crate::opencode_install::detect_opencode() {
            config.agents.opencode = Some(AgentBackendConfig {
                binary: binary.clone(),
                default_flags: vec!["acp".to_string()],
            });
            report.opencode = Some(DiscoveredAgent {
                binary,
                version: Some(version),
            });
            report.changed = true;
        }
    }

    if config.agents.claude_code.is_none() {
        if let Some(binary) = discover_claude_binary() {
            let version = probe_version(&binary, &["--version"]);
            config.agents.claude_code = Some(AgentBackendConfig {
                binary: binary.clone(),
                default_flags: Vec::new(),
            });
            report.claude_code = Some(DiscoveredAgent { binary, version });
            report.changed = true;
        }
    }

    if config.agents.codex.is_none() {
        if let Some(binary) = resolve_command("codex") {
            let version = probe_version(&binary, &["--version"]);
            config.agents.codex = Some(AgentBackendConfig {
                binary: binary.clone(),
                default_flags: Vec::new(),
            });
            report.codex = Some(DiscoveredAgent { binary, version });
            report.changed = true;
        }
    }

    if report.changed {
        info!(
            opencode = report.opencode.is_some(),
            claude_code = report.claude_code.is_some(),
            codex = report.codex.is_some(),
            "auto-discovered agent backends"
        );
    }

    report
}

/// Merge discoveries into `config` and atomically persist when anything changed.
pub fn discover_and_persist(
    config: &mut DaemonConfig,
    path: &Path,
) -> crate::error::Result<DiscoverReport> {
    let report = discover_and_merge(config);
    if report.changed {
        save_atomically(config, path)?;
        info!(path = %path.display(), "wrote auto-discovered agents to daemon.toml");
    }
    Ok(report)
}

fn auto_discover_disabled(config: &DaemonConfig) -> bool {
    if std::env::var_os("AMUXD_NO_AUTO_DISCOVER").is_some() {
        return true;
    }
    !config.agents.auto_discover
}

/// Claude Code: prefer a real `claude` binary; fall back to `npx` (spawn uses
/// the `@zed-industries/claude-agent-acp` wrapper when binary name is `claude`).
fn discover_claude_binary() -> Option<String> {
    resolve_command("claude").or_else(|| {
        resolve_command("npx").map(|_| "claude".to_string())
    })
}

fn resolve_command(name: &str) -> Option<String> {
    let path = crate::runtime::adapter::enriched_spawn_path(
        std::env::var("PATH").ok().as_deref(),
        dirs::home_dir().as_deref(),
    );
    let script = format!(
        "PATH={} command -v {}",
        shell_escape(&path),
        shell_escape(name)
    );
    let out = std::process::Command::new("sh")
        .arg("-lc")
        .arg(&script)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let resolved = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    (!resolved.is_empty()).then_some(resolved)
}

fn probe_version(binary: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(binary).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    (!line.is_empty()).then_some(line)
}

fn shell_escape(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-:".contains(c))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn save_atomically(config: &DaemonConfig, path: &Path) -> crate::error::Result<()> {
    let tmp = path.with_extension("toml.tmp");
    config.save(&tmp)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        crate::error::AmuxError::Config(format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            path.display()
        ))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ActorConfig, AgentsConfig, DaemonConfig, MqttConfig};

    fn base_config() -> DaemonConfig {
        DaemonConfig {
            actor: ActorConfig {
                id: "dev-1".to_string(),
                name: "Mac".to_string(),
            },
            mqtt: MqttConfig {
                broker_url: "tcp://localhost:1883".to_string(),
                username: None,
                password: None,
            },
            agents: AgentsConfig::default(),
            transport: None,
            team_id: None,
            channels: Default::default(),
            idle_runtime_timeout_secs: None,
            http: None,
        }
    }

    #[test]
    fn discover_skipped_when_auto_discover_disabled() {
        let mut cfg = base_config();
        cfg.agents.auto_discover = false;
        let report = discover_and_merge(&mut cfg);
        assert!(report.skipped);
        assert!(!report.changed);
    }

    #[test]
    fn discover_does_not_overwrite_existing_sections() {
        let mut cfg = base_config();
        cfg.agents.opencode = Some(AgentBackendConfig {
            binary: "/custom/opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });
        cfg.agents.claude_code = Some(AgentBackendConfig {
            binary: "/custom/claude".to_string(),
            default_flags: Vec::new(),
        });
        cfg.agents.codex = Some(AgentBackendConfig {
            binary: "/custom/codex".to_string(),
            default_flags: Vec::new(),
        });
        let report = discover_and_merge(&mut cfg);
        assert!(!report.changed);
        assert_eq!(
            cfg.agents.opencode.as_ref().unwrap().binary,
            "/custom/opencode"
        );
    }

    #[test]
    fn persist_writes_tmp_then_renames() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        let mut cfg = base_config();
        cfg.agents.opencode = Some(AgentBackendConfig {
            binary: "/tmp/opencode".to_string(),
            default_flags: vec!["acp".to_string()],
        });

        let report = DiscoverReport {
            changed: true,
            opencode: Some(DiscoveredAgent {
                binary: "/tmp/opencode".into(),
                version: None,
            }),
            ..Default::default()
        };
        save_atomically(&cfg, &path).unwrap();
        assert!(path.exists());
        assert!(!path.with_extension("toml.tmp").exists());

        let loaded = DaemonConfig::load(&path).unwrap();
        assert_eq!(
            loaded.agents.opencode.as_ref().unwrap().binary,
            "/tmp/opencode"
        );
        let _ = report;
    }

    #[test]
    fn resolve_command_finds_sh() {
        assert!(resolve_command("sh").is_some());
    }
}
