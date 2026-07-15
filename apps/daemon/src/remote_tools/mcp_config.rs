use std::path::PathBuf;

use crate::config::DaemonConfig;

fn sanitize_for_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

pub fn remote_tools_mcp_config_path(session_id: &str) -> PathBuf {
    DaemonConfig::config_dir()
        .join("mcp-configs")
        .join(format!("remote-{}.json", sanitize_for_filename(session_id)))
}

/// Write per-session MCP config for `amuxd remote-tools-mcp`.
/// `member_actor_id` is the human member actor — RPC is published to
/// `amux/{team}/{member_actor_id}/rpc/req` so all of that member's online clients receive it.
pub fn write_remote_tools_mcp_config(
    session_id: &str,
    team_id: &str,
    member_actor_id: &str,
) -> crate::error::Result<PathBuf> {
    if session_id.is_empty() || member_actor_id.is_empty() {
        return Err(crate::error::AmuxError::Agent(
            "write_remote_tools_mcp_config: session_id and member_actor_id required".into(),
        ));
    }

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
    let cfg = serde_json::json!({
        "mcpServers": {
            "amuxd-remote-tools": {
                "command": amuxd_bin.to_string_lossy(),
                "args": [
                    "remote-tools-mcp",
                    format!("--session-id={}", session_id),
                    format!("--team-id={}", team_id),
                    format!("--member-actor-id={}", member_actor_id),
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

/// MCP config for `session/resume`: write when requester is known, else reuse on-disk file.
pub fn resolve_remote_tools_mcp_config_for_resume(
    session_id: &str,
    team_id: &str,
    requester_actor_id: Option<&str>,
) -> Option<PathBuf> {
    if session_id.is_empty() {
        return None;
    }
    if let Some(member) = requester_actor_id.filter(|s| !s.is_empty()) {
        match write_remote_tools_mcp_config(session_id, team_id, member) {
            Ok(path) => return Some(path),
            Err(e) => {
                tracing::warn!(
                    session_id,
                    err = %e,
                    "resolve_remote_tools_mcp_config_for_resume: write failed, trying existing file"
                );
            }
        }
    }
    let path = remote_tools_mcp_config_path(session_id);
    path.is_file().then_some(path)
}
