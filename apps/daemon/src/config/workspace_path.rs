//! Workspace path policy shared by the registry, link sweep, and HTTP registration.

use std::path::Path;

/// Reject workspace paths that must never receive a `teamclu-team` link: the
/// filesystem root, or anything inside the daemon's own config dir
/// (`~/.amuxd`). The critical case is a team's global store dir
/// `~/.amuxd/teams/<id>`: linking it would point `teamclu-team` at itself
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

/// Decide whether a cloud `workspaces` row belongs in a listing shown on
/// *this* machine, returning its `(path, display_name)` if so.
///
/// Three independent reasons a row is dropped, and every listing surface needs
/// all three:
/// - **archived** — `GET /v1/workspaces` returns retired rows too (the desktop
///   hides them client-side). Their directories usually still exist, so no
///   path check catches them.
/// - **not linkable** — the daemon's own config dir / `/` (see
///   [`is_linkable_workspace_path`]).
/// - **not on this machine** — the cloud list spans every device on the team.
pub fn listable_local_workspace(row: &crate::backend::WorkspaceRow) -> Option<(String, String)> {
    if row.archived {
        return None;
    }
    let path = row.path.as_deref()?.trim();
    if path.is_empty() || !is_linkable_workspace_path(path) {
        return None;
    }
    if !Path::new(path).is_dir() {
        return None;
    }
    let display_name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    Some((path.to_string(), display_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::WorkspaceRow;

    fn row(path: Option<&str>, archived: bool) -> WorkspaceRow {
        WorkspaceRow {
            id: "ws-1".into(),
            team_id: "team-1".into(),
            path: path.map(str::to_string),
            archived,
            agent_id: None,
        }
    }

    #[test]
    fn listable_drops_archived_rows_even_when_the_directory_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        assert!(listable_local_workspace(&row(Some(&path), false)).is_some());
        assert!(listable_local_workspace(&row(Some(&path), true)).is_none());
    }

    #[test]
    fn listable_drops_rows_without_a_local_directory() {
        assert!(listable_local_workspace(&row(None, false)).is_none());
        assert!(listable_local_workspace(&row(Some("   "), false)).is_none());
        assert!(
            listable_local_workspace(&row(Some("/definitely/not/here/teamclu"), false)).is_none()
        );
    }

    #[test]
    fn listable_names_a_workspace_after_its_directory() {
        let parent = tempfile::tempdir().unwrap();
        let ws = parent.path().join("TeamClu Dev");
        std::fs::create_dir(&ws).unwrap();
        let (path, name) =
            listable_local_workspace(&row(Some(&ws.to_string_lossy()), false)).unwrap();
        assert_eq!(path, ws.to_string_lossy());
        assert_eq!(name, "TeamClu Dev");
    }

    #[test]
    fn rejects_daemon_config_paths() {
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        let amuxd = super::super::DaemonConfig::config_dir();
        assert!(!is_linkable_workspace_path(
            &amuxd.join("teams/t1").to_string_lossy()
        ));
        assert!(is_linkable_workspace_path("/tmp/my-project"));
    }
}
