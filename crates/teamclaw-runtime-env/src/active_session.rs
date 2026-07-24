//! TeamClaw cloud session id handoff for MCP tools (e.g. `get_session_deeplink`).
//!
//! The daemon stamps the active session into `{workspace}/.teamclaw/active-session-id`
//! before each agent turn so workspace-scoped MCP servers can resolve "current session"
//! without an explicit tool argument.

use std::path::Path;

use crate::atomic_write;

pub const TEAMCLAW_DIR: &str = ".teamclaw";
pub const ACTIVE_SESSION_ID_FILE: &str = "active-session-id";
pub const TEAMCLAW_SESSION_ID_ENV: &str = "TEAMCLAW_SESSION_ID";

pub fn active_session_id_path(workspace: &Path) -> std::path::PathBuf {
    workspace.join(TEAMCLAW_DIR).join(ACTIVE_SESSION_ID_FILE)
}

/// Read the last TeamClaw cloud session id stamped for this workspace.
pub fn read_active_session_id(workspace: &Path) -> Option<String> {
    let path = active_session_id_path(workspace);
    let raw = std::fs::read_to_string(path).ok()?;
    let id = raw.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// Stamp the TeamClaw cloud session id for this workspace (best-effort).
pub fn write_active_session_id(workspace: &Path, session_id: &str) -> std::io::Result<()> {
    let id = session_id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let path = active_session_id_path(workspace);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut content = id.to_string();
    content.push('\n');
    atomic_write::atomic_write(&path, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_active_session_id() {
        let dir = tempfile::tempdir().unwrap();
        write_active_session_id(dir.path(), "a1ca8f06-94ee-4fb5-bdfb-194a5606062f").unwrap();
        assert_eq!(
            read_active_session_id(dir.path()).as_deref(),
            Some("a1ca8f06-94ee-4fb5-bdfb-194a5606062f")
        );
    }

    #[test]
    fn read_missing_active_session_id_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_active_session_id(dir.path()).is_none());
    }
}
