use std::path::PathBuf;

use crate::config::DaemonConfig;
use tracing::info;

pub const REMOTE_TOOLS_MCP_SERVER_NAME: &str = "amuxd-remote-tools";

pub fn remote_tools_mcp_config_path(session_id: &str) -> PathBuf {
    let _ = session_id;
    DaemonConfig::config_dir()
        .join("mcp-configs")
        .join("remote-tools-host.json")
}

/// Write host-level MCP config for `amuxd remote-tools-mcp`.
/// Message-level routing is resolved by daemon using `remote_context_id`.
pub fn write_remote_tools_mcp_config(
    session_id: &str,
    team_id: &str,
    member_actor_id: &str,
) -> crate::error::Result<PathBuf> {
    let _ = (session_id, team_id, member_actor_id);

    let path = remote_tools_mcp_config_path(session_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::error::AmuxError::Agent(format!(
                "write_remote_tools_mcp_config: mkdir {}: {e}",
                parent.display()
            ))
        })?;
    }

    let amuxd_bin = std::env::current_exe()
        .map_err(|e| crate::error::AmuxError::Agent(format!("current_exe(): {e}")))?;
    let sock = DaemonConfig::sock_path();
    info!(
        path = %path.display(),
        amuxd_bin = %amuxd_bin.display(),
        sock = %sock.display(),
        "write_remote_tools_mcp_config: writing host-level MCP config"
    );
    let cfg = serde_json::json!({
        "mcpServers": {
            REMOTE_TOOLS_MCP_SERVER_NAME: {
                "command": amuxd_bin.to_string_lossy(),
                "args": [
                    "remote-tools-mcp",
                    format!("--sock={}", sock.to_string_lossy()),
                ],
            }
        }
    });
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| {
        crate::error::AmuxError::Agent(format!("write_remote_tools_mcp_config: serialize: {e}"))
    })?;
    std::fs::write(&path, body).map_err(|e| {
        crate::error::AmuxError::Agent(format!(
            "write_remote_tools_mcp_config: write {}: {e}",
            path.display()
        ))
    })?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_tools_config_path_is_host_level() {
        assert_eq!(
            remote_tools_mcp_config_path("session-a"),
            remote_tools_mcp_config_path("session-b")
        );
        assert!(remote_tools_mcp_config_path("session-a").ends_with("remote-tools-host.json"));
    }
}
