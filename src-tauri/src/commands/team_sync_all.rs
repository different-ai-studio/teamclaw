use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::team::check_team_status;

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncAllResult {
    pub mode: String,
    pub success: bool,
    pub message: String,
    pub changed_files: u32,
}

pub async fn sync_all(app: &AppHandle, workspace: &str) -> SyncAllResult {
    let status = check_team_status(workspace);
    match status.mode.as_deref() {
        Some("git") => sync_git(app).await,
        Some("oss") | Some("webdav") => sync_oss(app).await,
        Some("p2p") => sync_p2p(app).await,
        _ => SyncAllResult {
            mode: "none".to_string(),
            success: false,
            message: "No team sync configured in this workspace.".to_string(),
            changed_files: 0,
        },
    }
}

async fn sync_git(app: &AppHandle) -> SyncAllResult {
    use crate::commands::opencode::OpenCodeState;
    use crate::commands::shared_secrets::SharedSecretsState;
    use crate::commands::team::team_sync_repo;

    let opencode = app.state::<OpenCodeState>();
    let secrets = app.state::<SharedSecretsState>();

    match team_sync_repo(opencode, secrets, Some(false)).await {
        Ok(result) if result.needs_confirmation => SyncAllResult {
            mode: "git".to_string(),
            success: false,
            message: format!(
                "Sync blocked: {} untracked file(s) exceed size thresholds ({} bytes total).",
                result.new_files.len(),
                result.total_bytes
            ),
            changed_files: result.new_files.len() as u32,
        },
        Ok(result) => SyncAllResult {
            mode: "git".to_string(),
            success: result.success,
            message: result.message,
            changed_files: 0,
        },
        Err(e) => SyncAllResult {
            mode: "git".to_string(),
            success: false,
            message: e,
            changed_files: 0,
        },
    }
}

async fn sync_oss(app: &AppHandle) -> SyncAllResult {
    use crate::commands::oss_sync::OssSyncState;
    use teamclaw_sync::oss_types::DocType;

    let oss_state = app.state::<OssSyncState>();
    // Hold the mutex for the entire sync operation to serialize with the background poll loop.
    // OssSyncManager cannot be accessed without holding this lock.
    let mut manager_guard = oss_state.manager.lock().await;

    let manager = match manager_guard.as_mut() {
        Some(m) => m,
        None => {
            return SyncAllResult {
                mode: "oss".to_string(),
                success: false,
                message: "OSS sync not initialized. Please connect to a team first.".to_string(),
                changed_files: 0,
            }
        }
    };

    if let Err(e) = manager.initial_sync().await {
        return SyncAllResult {
            mode: "oss".to_string(),
            success: false,
            message: format!("OSS pull failed: {e}"),
            changed_files: 0,
        };
    }

    let doc_types = [DocType::Skills, DocType::Mcp, DocType::Knowledge, DocType::Meta];
    let mut changed = 0u32;
    let mut changed_names: Vec<String> = Vec::new();

    for dt in doc_types {
        match manager.upload_local_changes_incremental(dt).await {
            Ok(true) => {
                changed += 1;
                changed_names.push(dt.path().to_string());
            }
            Ok(false) => {}
            Err(e) => {
                return SyncAllResult {
                    mode: "oss".to_string(),
                    success: false,
                    message: format!("OSS push failed for {}: {e}", dt.path()),
                    changed_files: changed,
                };
            }
        }
    }

    let message = if changed == 0 {
        "Synced via oss: no changes.".to_string()
    } else {
        format!(
            "Synced via oss: {} doc type(s) changed ({}).",
            changed,
            changed_names.join(", ")
        )
    };

    SyncAllResult {
        mode: "oss".to_string(),
        success: true,
        message,
        changed_files: changed,
    }
}

#[cfg(feature = "p2p")]
async fn sync_p2p(app: &AppHandle) -> SyncAllResult {
    use crate::commands::p2p_state::SyncEngineState;

    let engine_state = app.state::<SyncEngineState>();
    let engine = engine_state.lock().await;
    let snapshot = engine.snapshot();

    let is_running = !matches!(snapshot.status, teamclaw_p2p::EngineStatus::Disconnected);

    let message = format!(
        "P2P sync {}: {} synced, {} pending, {} peer(s) connected.",
        if is_running { "active" } else { "inactive" },
        snapshot.synced_files,
        snapshot.pending_files,
        snapshot.peers.len(),
    );

    SyncAllResult {
        mode: "p2p".to_string(),
        success: is_running,
        message,
        changed_files: snapshot.synced_files,
    }
}

#[cfg(not(feature = "p2p"))]
async fn sync_p2p(_app: &AppHandle) -> SyncAllResult {
    SyncAllResult {
        mode: "p2p".to_string(),
        success: false,
        message: "P2P sync is not available on this platform.".to_string(),
        changed_files: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_all_result_serialization() {
        let result = SyncAllResult {
            mode: "git".to_string(),
            success: true,
            message: "Synced with origin/main.".to_string(),
            changed_files: 0,
        };
        let json = serde_json::to_string(&result).unwrap();
        let roundtrip: SyncAllResult = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtrip.mode, "git");
        assert!(roundtrip.success);
    }

    #[test]
    fn test_sync_all_result_none_mode() {
        let result = SyncAllResult {
            mode: "none".to_string(),
            success: false,
            message: "No team sync configured in this workspace.".to_string(),
            changed_files: 0,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""mode":"none""#));
        assert!(json.contains(r#""success":false"#));
    }
}
