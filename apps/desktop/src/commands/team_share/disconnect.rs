//! Full team-share disconnect: local materialization + cloud share-mode reset.
//!
//! - Removes `teamclu-team` (symlink or dir) in the current workspace and every
//!   other workspace bound to this team, per the Cloud API `workspaces` table
//! - Deletes `~/.amuxd/teams/<team_id>/` (global copy, secrets, sync state)
//! - Clears the workspace-local team secret
//! - Clears legacy `team_mode` in `.teamclu/teamclu.json`
//! - `DELETE /v1/teams/:id/share-mode` so the owner can re-run the share wizard

use std::collections::HashSet;
use std::path::PathBuf;

use tauri::{State, WebviewWindow};
use tracing::info;

use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::resolve_runtime_fc_endpoint;
use crate::commands::team::resolve_workspace_path;
use crate::commands::team_share::enable::load_team_workspaces;
use crate::commands::team_sync_proxy;
use crate::commands::{team_secret_store, TEAM_REPO_DIR};

/// Oldest team-drive directory name, from before `<workspace>/teamclaw-team`.
/// Names a directory that may still exist on disk, so it does not follow the
/// teamclaw → teamclu rebrand — renaming it points the cleanup at a path that
/// never existed and leaves the real one behind forever.
const LEGACY_TEAM_REPO: &str = "teamclaw";

/// `~/.amuxd/teams/<team_id>/` — daemon home for this team (global checkout +
/// default workspace).
pub fn global_team_home_dir(team_id: &str) -> Option<PathBuf> {
    if team_id.trim().is_empty() {
        return None;
    }
    Some(crate::commands::amuxd_team_dir(team_id))
}

/// `~/.amuxd/teams/<team_id>/state/secrets.enc` — the daemon's encrypted team
/// secrets, and the per-team key that opens them.
///
/// Mirrors `SecretStore` in the daemon. They sit back inside
/// `global_team_home_dir` again, under `state/`, so removing that directory
/// erases them as a side effect — but this stays explicit, because a disconnect
/// that only got as far as the secrets must still take them.
pub fn global_team_secrets_path(team_id: &str) -> Option<PathBuf> {
    if team_id.trim().is_empty() {
        return None;
    }
    Some(
        crate::commands::amuxd_team_dir(team_id)
            .join("state")
            .join("secrets.enc"),
    )
}

/// Remove the daemon's stored secrets for a team. Absent secrets are not an error.
pub fn remove_global_team_secrets(team_id: &str) -> Result<(), String> {
    let Some(path) = global_team_secrets_path(team_id) else {
        return Ok(());
    };
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "Failed to remove team secrets {}: {}",
            path.display(),
            e
        )),
    }
}

/// Remove `<workspace>/teamclu-team` whether it is a symlink, junction, or real dir.
pub fn remove_workspace_team_repo_entry(workspace_path: &str) -> Result<(), String> {
    let link = std::path::Path::new(workspace_path).join(TEAM_REPO_DIR);
    match std::fs::symlink_metadata(&link) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to inspect {}: {}", link.display(), e)),
        Ok(meta) if meta.file_type().is_symlink() => {
            #[cfg(unix)]
            {
                std::fs::remove_file(&link)
                    .map_err(|e| format!("Failed to remove symlink {}: {}", link.display(), e))
            }
            #[cfg(windows)]
            {
                std::fs::remove_dir(&link)
                    .map_err(|e| format!("Failed to remove junction {}: {}", link.display(), e))
            }
        }
        Ok(_) => std::fs::remove_dir_all(&link)
            .map_err(|e| format!("Failed to remove directory {}: {}", link.display(), e)),
    }
}

/// Remove the entire daemon team home (`~/.amuxd/teams/<team_id>/`).
pub fn remove_global_team_home(team_id: &str) -> Result<(), String> {
    let Some(dir) = global_team_home_dir(team_id) else {
        return Ok(());
    };
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| {
        format!(
            "Failed to remove global team directory {}: {}",
            dir.display(),
            e
        )
    })
}

fn remove_legacy_workspace_team_repo(workspace_path: &str) -> Result<(), String> {
    let legacy = std::path::Path::new(workspace_path).join(LEGACY_TEAM_REPO);
    if !legacy.is_dir() {
        return Ok(());
    }
    if std::fs::symlink_metadata(&legacy)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Ok(());
    }
    std::fs::remove_dir_all(&legacy).map_err(|e| {
        format!(
            "Failed to remove legacy team directory {}: {}",
            legacy.display(),
            e
        )
    })
}

fn clear_workspace_team_local_config(workspace_path: &str, team_id: &str) -> Result<(), String> {
    let _ = team_secret_store::delete_team_secret(workspace_path, team_id);
    Ok(())
}

async fn collect_workspace_paths(
    team_id: &str,
    primary: &str,
    access_token: &str,
    cloud_api_url: &str,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    fn push(p: &str, seen: &mut HashSet<String>, out: &mut Vec<String>) {
        let t = p.trim();
        if t.is_empty() || !seen.insert(t.to_string()) {
            return;
        }
        out.push(t.to_string());
    }
    push(primary, &mut seen, &mut out);
    for w in load_team_workspaces(team_id, primary, access_token, cloud_api_url).await {
        push(&w.path, &mut seen, &mut out);
    }
    out
}

async fn disable_cloud_share_mode(
    _workspace_path: &str,
    team_id: &str,
    access_token: &str,
    cloud_api_url: &str,
) -> Result<(), String> {
    let fc = FcClient::new(
        resolve_runtime_fc_endpoint(cloud_api_url)?,
        access_token.to_string(),
    );
    let path = format!("/v1/teams/{team_id}/share-mode");
    fc.delete_json(&path).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete local team-shared materialization and reset cloud share-mode.
#[tauri::command]
pub async fn team_disconnect_repo(
    team_id: Option<String>,
    workspace_path: Option<String>,
    access_token: Option<String>,
    cloud_api_url: String,
    window: WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<serde_json::Value, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    let team_id = team_id
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "teamId is required to disconnect team share".to_string())?;

    info!(
        team_id = %team_id,
        workspace_path = %workspace_path,
        "team_disconnect_repo: start"
    );

    let token = access_token
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "accessToken is required to clear cloud team-share binding".to_string())?;

    disable_cloud_share_mode(&workspace_path, &team_id, &token, &cloud_api_url).await?;

    let paths = collect_workspace_paths(&team_id, &workspace_path, &token, &cloud_api_url).await;
    for path in &paths {
        remove_workspace_team_repo_entry(path)?;
        remove_legacy_workspace_team_repo(path)?;
        clear_workspace_team_local_config(path, &team_id)?;
        if let Err(e) = team_sync_proxy::daemon_team_unlink(path).await {
            tracing::warn!(
                team_id = %team_id,
                workspace_path = %path,
                "daemon team unlink deferred: {e}"
            );
        }
    }

    remove_global_team_home(&team_id)?;
    remove_global_team_secrets(&team_id)?;

    info!(
        team_id = %team_id,
        workspaces = paths.len(),
        "team_disconnect_repo: done"
    );

    Ok(serde_json::json!({
        "success": true,
        "message": "Disconnected team share (local + cloud)",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_workspace_symlink_without_deleting_target() {
        let ws = tempfile::tempdir().unwrap();
        let global = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(global.path(), ws.path().join(TEAM_REPO_DIR)).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(global.path(), ws.path().join(TEAM_REPO_DIR)).unwrap();

        remove_workspace_team_repo_entry(ws.path().to_str().unwrap()).unwrap();
        assert!(!ws.path().join(TEAM_REPO_DIR).exists());
        assert!(global.path().exists());
    }

    /// Disconnect must take the whole team directory, not just the synced
    /// subtree — `state/` holds credentials and sync watermarks that would
    /// otherwise outlive the team.
    ///
    /// Redirects `HOME`. It used to build its fixture in the developer's real
    /// `~/.amuxd`, and its second write (`sync/state.json`) landed in a
    /// directory it never created — so it only passed on a machine where an
    /// earlier run had left one behind, and failed outright on a clean one.
    #[test]
    fn removes_global_team_home_dir() {
        let _guard = home_lock().lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        let _home = HomeGuard::set(home.path());

        let team_id = "team-disconnect-home-test";
        let dir = global_team_home_dir(team_id).expect("a non-empty team id yields a path");

        let shared = crate::commands::amuxd_team_shared_dir(team_id);
        std::fs::create_dir_all(&shared).unwrap();
        let state = dir.join("state");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("sync.json"), b"{}").unwrap();

        remove_global_team_home(team_id).unwrap();
        assert!(!dir.exists());
    }

    fn home_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    struct HomeGuard {
        original: Option<std::ffi::OsString>,
    }

    impl HomeGuard {
        fn set(path: &std::path::Path) -> Self {
            let original = std::env::var_os("HOME");
            std::env::set_var("HOME", path);
            Self { original }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    /// The daemon's secrets moved out of `teams/<id>/`, so `remove_global_team_home`
    /// no longer erases them as a side effect. Disconnect must take them itself.
    /// Removes its directory on the way out even when the assert fails: these
    /// tests write the REAL amuxd home (the desktop resolves it by brand, so
    /// `$AMUXD_HOME` cannot redirect them), and a failed run must not leave a
    /// fake team behind on a developer machine.
    #[test]
    fn removes_daemon_team_secrets() {
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let team_id = "team-disconnect-secrets-test";
        let _cleanup = Cleanup(crate::commands::amuxd_team_dir(team_id));
        let Some(path) = global_team_secrets_path(team_id) else {
            return;
        };
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"encrypted-blob").unwrap();

        remove_global_team_secrets(team_id).unwrap();
        assert!(
            !path.exists(),
            "disconnect must not leave team secrets behind"
        );
    }

    #[test]
    fn removing_absent_team_secrets_is_not_an_error() {
        remove_global_team_secrets("team-that-never-existed-xyz").unwrap();
    }
}
