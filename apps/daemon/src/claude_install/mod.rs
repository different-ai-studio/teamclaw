//! Claude Code CLI discovery for `amuxd doctor`.
//!
//! The claude backend spawns the `claude` binary named by
//! `AgentLaunchConfig` — `[agents.claude_code].binary` when configured, else the
//! literal `"claude"` from `RuntimeManager::default_launch_configs`. Unlike
//! opencode there is nothing for us to install or update, and unlike cursor
//! there is no API key we hold: `claude` owns its own auth on the host. So the
//! only question worth answering is whether the binary is reachable at all.
//!
//! Without this, a claude-configured daemon reported *opencode's* install status
//! as its primary runtime, which the desktop then labelled "OpenCode 运行时" — a
//! pass/fail about the wrong program.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    /// The binary the runtime would spawn (configured path or bare `claude`).
    pub binary: String,
    /// True when `[agents.claude_code].binary` names it explicitly.
    pub binary_configured: bool,
    pub binary_present: bool,
    /// Version string from `<binary> --version`, when it answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub satisfied: bool,
}

pub fn doctor() -> ClaudeStatus {
    let configured =
        crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
            .ok()
            .and_then(|c| c.agents.claude_code)
            .map(|c| c.binary)
            .filter(|b| !b.trim().is_empty());
    let binary_configured = configured.is_some();
    let binary = configured.unwrap_or_else(|| "claude".to_string());

    let version = claude_version(&binary);
    let binary_present = version.is_some();

    ClaudeStatus {
        binary,
        binary_configured,
        binary_present,
        version,
        satisfied: binary_present,
    }
}

/// `<binary> --version` → its first line, or `None` when it cannot be run.
///
/// Invoking it is the check: an absolute path can exist without being
/// executable, and a bare name has to be resolved through PATH anyway.
fn claude_version(binary: &str) -> Option<String> {
    let out = std::process::Command::new(binary)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_string())
}
