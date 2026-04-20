use serde::{Deserialize, Serialize};
use tauri::AppHandle;

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

async fn sync_git(_app: &AppHandle) -> SyncAllResult {
    SyncAllResult {
        mode: "git".to_string(),
        success: false,
        message: "git sync not yet implemented".to_string(),
        changed_files: 0,
    }
}

async fn sync_oss(_app: &AppHandle) -> SyncAllResult {
    SyncAllResult {
        mode: "oss".to_string(),
        success: false,
        message: "oss sync not yet implemented".to_string(),
        changed_files: 0,
    }
}

async fn sync_p2p(_app: &AppHandle) -> SyncAllResult {
    SyncAllResult {
        mode: "p2p".to_string(),
        success: false,
        message: "p2p sync not yet implemented".to_string(),
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
