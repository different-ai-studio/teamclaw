//! Materialize team global dir + workspace `teamclaw-team` link.
//!
//! Shared by the daemon core and the HTTP `/v1/team/link` handler so HTTP
//! integration tests do not need to pull in `daemon::server`.

use std::path::Path;

use tracing::{debug, info, warn};

use crate::backend::Backend;
use crate::config::global_team_store::{self, TEAM_LINK_NAME};
use crate::config::workspace_link::LinkStatus;

/// Result of consulting the cloud share-mode endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamShareGate {
    /// `share_mode` is set (oss / managed_git / custom_git).
    Enabled,
    /// Team-share is off (`mode` null / missing).
    Disabled,
    /// Cloud lookup failed — do not tear down existing links on a background sweep.
    Unknown,
}

pub async fn team_share_gate(backend: &dyn Backend, team_id: &str) -> TeamShareGate {
    match backend.team_share_config(team_id).await {
        Ok(cfg) => {
            if cfg
                .mode
                .as_deref()
                .filter(|m| !m.trim().is_empty())
                .is_some()
            {
                TeamShareGate::Enabled
            } else {
                TeamShareGate::Disabled
            }
        }
        Err(e) => {
            warn!(team_id, "team_share_config failed, leaving links unchanged: {e}");
            TeamShareGate::Unknown
        }
    }
}

/// Whether team-share is actively enabled (excludes `Unknown`).
pub async fn team_share_enabled(backend: &dyn Backend, team_id: &str) -> bool {
    matches!(
        team_share_gate(backend, team_id).await,
        TeamShareGate::Enabled
    )
}

/// Remove `<workspace>/teamclaw-team` when it is a symlink/junction; remove a
/// real directory if one was materialized locally (legacy).
pub fn remove_workspace_team_link(ws_path: &str) -> std::io::Result<()> {
    let link = Path::new(ws_path.trim()).join(TEAM_LINK_NAME);
    match std::fs::symlink_metadata(&link) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(meta) if meta.file_type().is_symlink() => {
            #[cfg(unix)]
            {
                std::fs::remove_file(&link)
            }
            #[cfg(windows)]
            {
                std::fs::remove_dir(&link)
            }
        }
        Ok(_) => std::fs::remove_dir_all(&link),
    }
}

/// Drop `~/.amuxd/teams/<team_id>/` when the global copy is still empty scaffold.
pub fn prune_scaffold_team_home(team_id: &str) {
    let global = global_team_store::global_team_dir(team_id);
    if !global_team_store::is_scaffold_only(&global) {
        return;
    }
    let Some(team_home) = global.parent() else {
        return;
    };
    if let Err(e) = std::fs::remove_dir_all(team_home) {
        debug!(team_id, path = %team_home.display(), "prune scaffold team home failed: {e}");
    }
}

/// Background sweep policy: link when enabled; tear down only when share-mode is
/// confirmed off; leave paths alone on transient cloud errors (`Unknown`).
pub fn materialize_or_teardown(gate: TeamShareGate, team_id: &str, ws_path: &str) -> LinkStatus {
    match gate {
        TeamShareGate::Enabled => ensure_team_link(team_id, ws_path),
        TeamShareGate::Disabled => {
            if let Err(e) = remove_workspace_team_link(ws_path) {
                debug!(
                    team_id,
                    workspace = %ws_path,
                    "team unlink (workspace entry) skipped: {e}"
                );
            }
            prune_scaffold_team_home(team_id);
            LinkStatus::Fallback
        }
        TeamShareGate::Unknown => LinkStatus::Fallback,
    }
}

/// Idempotently materialize a team's global shared dir and a workspace's
/// `teamclaw-team` symlink into it.
pub fn ensure_team_link(team_id: &str, ws_path: &str) -> LinkStatus {
    if team_id.trim().is_empty() || ws_path.trim().is_empty() {
        return LinkStatus::Fallback;
    }
    if let Err(e) = crate::config::global_team_store::ensure_initialized(team_id) {
        warn!(team_id, "global team dir init failed: {e}");
        return LinkStatus::Fallback;
    }
    let ws_root = Path::new(ws_path);
    let status = crate::config::workspace_link::ensure_workspace_link(ws_root, team_id);
    let effective = crate::config::global_team_store::resolve_team_dir(ws_root, team_id);
    info!(
        team_id,
        workspace = %ws_path,
        effective = %effective.display(),
        "team link: {status:?}"
    );
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_workspace_team_link_drops_symlink() {
        let ws = tempfile::tempdir().unwrap();
        let global = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(global.path(), ws.path().join(TEAM_LINK_NAME)).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(global.path(), ws.path().join(TEAM_LINK_NAME)).unwrap();

        remove_workspace_team_link(ws.path().to_str().unwrap()).unwrap();
        assert!(!ws.path().join(TEAM_LINK_NAME).exists());
        assert!(global.path().exists());
    }

    #[test]
    fn materialize_or_teardown_disabled_does_not_create_global_dir() {
        let _lock = global_team_store::TEST_HOME_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        // SAFETY: serialized by TEST_HOME_LOCK.
        unsafe { std::env::set_var("HOME", home.path()) };

        let team_id = "team-teardown-test";
        let ws = tempfile::tempdir().unwrap();
        materialize_or_teardown(TeamShareGate::Disabled, team_id, ws.path().to_str().unwrap());

        assert!(!global_team_store::global_team_dir(team_id).exists());
    }

    #[test]
    fn prune_scaffold_team_home_removes_empty_global_copy() {
        let _lock = global_team_store::TEST_HOME_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", home.path()) };

        let team_id = "team-prune-test";
        global_team_store::ensure_initialized(team_id).unwrap();
        let global = global_team_store::global_team_dir(team_id);
        assert!(global.exists());

        prune_scaffold_team_home(team_id);
        assert!(!global.exists());
    }
}
