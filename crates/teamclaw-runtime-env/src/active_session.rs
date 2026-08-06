//! TeamClaw cloud session id handoff for MCP tools (e.g. `get_session_deeplink`).
//!
//! The daemon stamps the active session into
//! `{workspace}/{meta}/active-session-id` before each agent turn so
//! workspace-scoped MCP servers can resolve "current session" without an
//! explicit tool argument. Meta dir follows the process brand (see
//! [`crate::workspace_meta_dir_name`]).

use std::path::Path;

use crate::atomic_write;
use crate::storage_namespace::{
    brand_short_name_from_env, resolve_workspace_meta_path, workspace_meta_write_path,
};

/// Deprecated alias — prefer brand helpers. Kept for external call sites that
/// still treat official meta as `.teamclaw`.
pub const TEAMCLAW_DIR: &str = crate::WORKSPACE_META_DIR;
pub const ACTIVE_SESSION_ID_FILE: &str = "active-session-id";
pub const TEAMCLAW_SESSION_ID_ENV: &str = "TEAMCLAW_SESSION_ID";

/// Canonical write path for the active-session stamp (brand meta dir).
pub fn active_session_id_write_path(workspace: &Path) -> std::path::PathBuf {
    workspace_meta_write_path(
        workspace,
        &brand_short_name_from_env(),
        ACTIVE_SESSION_ID_FILE,
    )
}

/// Resolve path for reads (canonical, else legacy `.teamclaw/`).
pub fn active_session_id_path(workspace: &Path) -> std::path::PathBuf {
    resolve_workspace_meta_path(
        workspace,
        &brand_short_name_from_env(),
        ACTIVE_SESSION_ID_FILE,
    )
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
    let path = active_session_id_write_path(workspace);
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
    use crate::storage_namespace::BRAND_SHORT_NAME_ENV;
    use crate::test_util::home_env_lock;

    #[test]
    fn write_then_read_active_session_id() {
        let _lock = home_env_lock();
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        let dir = tempfile::tempdir().unwrap();
        write_active_session_id(dir.path(), "a1ca8f06-94ee-4fb5-bdfb-194a5606062f").unwrap();
        assert_eq!(
            read_active_session_id(dir.path()).as_deref(),
            Some("a1ca8f06-94ee-4fb5-bdfb-194a5606062f")
        );
        assert!(dir
            .path()
            .join(".teamclaw")
            .join(ACTIVE_SESSION_ID_FILE)
            .exists());
    }

    #[test]
    fn read_missing_active_session_id_returns_none() {
        let _lock = home_env_lock();
        std::env::remove_var(BRAND_SHORT_NAME_ENV);
        let dir = tempfile::tempdir().unwrap();
        assert!(read_active_session_id(dir.path()).is_none());
    }

    #[test]
    fn white_label_writes_brand_meta_and_reads_legacy_fallback() {
        let _lock = home_env_lock();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(BRAND_SHORT_NAME_ENV, "copilot361");

        let legacy = dir.path().join(".teamclaw").join(ACTIVE_SESSION_ID_FILE);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "legacy-session\n").unwrap();
        assert_eq!(
            read_active_session_id(dir.path()).as_deref(),
            Some("legacy-session")
        );

        write_active_session_id(dir.path(), "brand-session").unwrap();
        let brand_path = dir
            .path()
            .join(".copilot361")
            .join(ACTIVE_SESSION_ID_FILE);
        assert!(brand_path.exists());
        assert_eq!(
            read_active_session_id(dir.path()).as_deref(),
            Some("brand-session")
        );

        std::env::remove_var(BRAND_SHORT_NAME_ENV);
    }
}
