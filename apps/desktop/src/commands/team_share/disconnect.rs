//! Full team-share disconnect: local materialization + cloud share-mode reset.
//!
//! - Removes `teamclaw-team` (symlink or dir) in the current workspace and every
//!   other workspace bound to this team, per the Cloud API `workspaces` table
//! - Deletes `~/.amuxd/teams/<team_id>/` (global copy, secrets, sync state)
//! - Clears workspace-local team secret + git credentials
//! - Clears legacy `team_mode` in `.teamclaw/teamclaw.json`
//! - `DELETE /v1/teams/:id/share-mode` so the owner can re-run the OSS/Git wizard

use std::collections::HashSet;
use std::path::PathBuf;

use tauri::{State, WebviewWindow};
use tracing::info;

use crate::commands::oss_sync::fc_client::FcClient;
use crate::commands::oss_sync::get_fc_endpoint;
use crate::commands::team::resolve_workspace_path;
use crate::commands::team_share::custom_git;
use crate::commands::team_share::enable::load_team_workspaces;
use crate::commands::team_sync_proxy;
use crate::commands::{team_secret_store, TEAM_REPO_DIR};

const LEGACY_TEAM_REPO: &str = "teamclaw";

/// `~/.amuxd/teams/<team_id>/` — daemon home for this team (global checkout +
/// default workspace).
pub fn global_team_home_dir(team_id: &str) -> Option<PathBuf> {
    if team_id.trim().is_empty() {
        return None;
    }
    dirs::home_dir().map(|h| h.join(".amuxd").join("teams").join(team_id))
}

/// `~/.amuxd/team-secrets/<team_id>.enc` — the daemon's encrypted team secrets.
///
/// Mirrors `SecretStore::secrets_path` in the daemon. These used to sit inside
/// `global_team_home_dir`, so removing that directory erased them as a side
/// effect; now that they live outside it, disconnect has to remove them
/// explicitly or a disconnected team leaves its credentials on disk.
pub fn global_team_secrets_path(team_id: &str) -> Option<PathBuf> {
    if team_id.trim().is_empty() {
        return None;
    }
    dirs::home_dir().map(|h| {
        h.join(".amuxd")
            .join("team-secrets")
            .join(format!("{team_id}.enc"))
    })
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

/// Remove `<workspace>/teamclaw-team` whether it is a symlink, junction, or real dir.
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
    let _ = custom_git::delete_credential(workspace_path, &format!("custom_git:{team_id}"));
    let _ = custom_git::delete_credential(workspace_path, &format!("managed_git:{team_id}"));
    Ok(())
}

async fn collect_workspace_paths(team_id: &str, primary: &str, access_token: &str) -> Vec<String> {
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
    for w in load_team_workspaces(team_id, primary, access_token).await {
        push(&w.path, &mut seen, &mut out);
    }
    out
}

async fn disable_cloud_share_mode(
    workspace_path: &str,
    team_id: &str,
    access_token: &str,
) -> Result<(), String> {
    let fc = FcClient::new(get_fc_endpoint(workspace_path), access_token.to_string());
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

    disable_cloud_share_mode(&workspace_path, &team_id, &token).await?;

    let paths = collect_workspace_paths(&team_id, &workspace_path, &token).await;
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

    #[test]
    fn removes_global_team_home_dir() {
        let team_id = "team-disconnect-home-test";
        let Some(dir) = global_team_home_dir(team_id) else {
            return;
        };
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        std::fs::create_dir_all(dir.join(TEAM_REPO_DIR)).unwrap();
        std::fs::write(dir.join("sync/state.json"), b"{}").unwrap();

        remove_global_team_home(team_id).unwrap();
        assert!(!dir.exists());
    }

    /// The daemon's secrets moved out of `teams/<id>/`, so `remove_global_team_home`
    /// no longer erases them as a side effect. Disconnect must take them itself.
    #[test]
    fn removes_daemon_team_secrets() {
        let team_id = "team-disconnect-secrets-test";
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
