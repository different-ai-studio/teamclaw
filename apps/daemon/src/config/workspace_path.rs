//! Workspace path policy shared by the registry, link sweep, and HTTP registration.

use std::path::Path;

/// Reject workspace paths that must never receive a `teamclaw-team` link: the
/// filesystem root, or anything inside the daemon's own config dir
/// (`~/.amuxd`). The critical case is a team's global store dir
/// `~/.amuxd/teams/<id>`: linking it would point `teamclaw-team` at itself
/// (ELOOP) and destroy the synced content. Such bogus entries have appeared in
/// workspaces.toml (synced from the cloud), so filter them at registration and
/// on load in addition to the guard in `workspace_link`.
pub fn is_linkable_workspace_path(path: &str) -> bool {
    let p = Path::new(path.trim());
    if path.trim().is_empty() || p == Path::new("/") {
        return false;
    }
    !p.starts_with(super::DaemonConfig::config_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_daemon_config_paths() {
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        let amuxd = super::super::DaemonConfig::config_dir();
        assert!(!is_linkable_workspace_path(&amuxd.join("teams/t1").to_string_lossy()));
        assert!(is_linkable_workspace_path("/tmp/my-project"));
    }
}
