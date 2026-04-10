use crate::commands::oss_sync::OssSyncState;
use crate::commands::oss_types::{DocType, MemberRole};
use crate::commands::version_store::VersionStore;
use crate::commands::version_types::{FileVersion, VersionedFileInfo};
use crate::commands::{CONFIG_FILE_NAME, TEAMCLAW_DIR, TEAM_REPO_DIR};

use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct VersionStoreState(pub Arc<Mutex<Option<VersionStore>>>);

impl Default for VersionStoreState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Detect active team mode: "oss", "p2p", or "none".
fn get_team_mode(workspace_path: &str) -> &'static str {
    let config_path = format!("{}/{}/{}", workspace_path, TEAMCLAW_DIR, CONFIG_FILE_NAME);
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return "none";
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return "none";
    };

    // OSS: oss.teamId exists
    if json.get("oss").and_then(|o| o.get("teamId")).is_some() {
        return "oss";
    }

    // P2P: p2p.enabled == true
    if json
        .get("p2p")
        .and_then(|p| p.get("enabled"))
        .and_then(|v| v.as_bool())
        == Some(true)
    {
        return "p2p";
    }

    "none"
}

fn parse_doc_type(s: &str) -> Result<DocType, String> {
    match s {
        "skills" => Ok(DocType::Skills),
        "mcp" => Ok(DocType::Mcp),
        "knowledge" => Ok(DocType::Knowledge),
        "meta" => Ok(DocType::Meta),
        _ => Err(format!("Unknown doc type: {s}")),
    }
}

/// Ensure the VersionStore is initialized for the given workspace.
/// Returns an error string if initialization fails.
async fn ensure_version_store(
    state: &VersionStoreState,
    workspace_path: &str,
) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if guard.is_none() {
        let store = VersionStore::new(workspace_path)
            .await
            .map_err(|e| format!("Failed to open VersionStore: {e}"))?;
        *guard = Some(store);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn team_list_file_versions(
    workspace_path: String,
    doc_type: String,
    file_path: String,
    oss_state: State<'_, OssSyncState>,
    version_state: State<'_, VersionStoreState>,
) -> Result<Vec<FileVersion>, String> {
    let mode = get_team_mode(&workspace_path);

    match mode {
        "oss" => {
            let dt = parse_doc_type(&doc_type)?;
            let guard = oss_state.manager.lock().await;
            let manager = guard
                .as_ref()
                .ok_or_else(|| "OSS sync not active".to_string())?;
            Ok(manager.list_file_versions(dt, &file_path))
        }
        "p2p" => {
            ensure_version_store(&version_state, &workspace_path).await?;
            let guard = version_state.0.lock().await;
            let store = guard.as_ref().unwrap();
            store
                .list_file_versions(&file_path, &doc_type)
                .await
                .map_err(|e| format!("Failed to list file versions: {e}"))
        }
        _ => Ok(Vec::new()),
    }
}

#[tauri::command]
pub async fn team_list_all_versioned_files(
    workspace_path: String,
    doc_type: Option<String>,
    oss_state: State<'_, OssSyncState>,
    version_state: State<'_, VersionStoreState>,
) -> Result<Vec<VersionedFileInfo>, String> {
    let mode = get_team_mode(&workspace_path);

    match mode {
        "oss" => {
            let dt = match &doc_type {
                Some(s) => Some(parse_doc_type(s)?),
                None => None,
            };
            let guard = oss_state.manager.lock().await;
            let manager = guard
                .as_ref()
                .ok_or_else(|| "OSS sync not active".to_string())?;
            Ok(manager.list_all_versioned_files(dt))
        }
        "p2p" => {
            ensure_version_store(&version_state, &workspace_path).await?;
            let guard = version_state.0.lock().await;
            let store = guard.as_ref().unwrap();
            store
                .list_all_versioned_files(doc_type.as_deref())
                .await
                .map_err(|e| format!("Failed to list versioned files: {e}"))
        }
        _ => Ok(Vec::new()),
    }
}

#[tauri::command]
pub async fn team_restore_file_version(
    workspace_path: String,
    doc_type: String,
    file_path: String,
    version_index: u32,
    oss_state: State<'_, OssSyncState>,
    version_state: State<'_, VersionStoreState>,
) -> Result<(), String> {
    let mode = get_team_mode(&workspace_path);

    match mode {
        "oss" => {
            let dt = parse_doc_type(&doc_type)?;
            let mut guard = oss_state.manager.lock().await;
            let manager = guard
                .as_mut()
                .ok_or_else(|| "OSS sync not active".to_string())?;

            // Viewers cannot restore
            if manager.role() == MemberRole::Viewer {
                return Err("Viewers cannot restore file versions".to_string());
            }

            manager.restore_file_version(dt, &file_path, version_index)
        }
        "p2p" => {
            ensure_version_store(&version_state, &workspace_path).await?;
            let guard = version_state.0.lock().await;
            let store = guard.as_ref().unwrap();

            // Get versions and find the requested one
            let versions = store
                .list_file_versions(&file_path, &doc_type)
                .await
                .map_err(|e| format!("Failed to list versions: {e}"))?;

            let version = versions
                .into_iter()
                .find(|v| v.index == version_index)
                .ok_or_else(|| {
                    format!("Version index {} not found for {file_path}", version_index)
                })?;

            // Determine destination path: {workspace}/{TEAM_REPO_DIR}/{dir_name}/{file_path}
            let dt = parse_doc_type(&doc_type)?;
            let dest = std::path::Path::new(&workspace_path)
                .join(TEAM_REPO_DIR)
                .join(dt.dir_name())
                .join(&file_path);

            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Failed to create parent directories for {}: {e}",
                        dest.display()
                    )
                })?;
            }

            std::fs::write(&dest, version.content.as_bytes())
                .map_err(|e| format!("Failed to write restored file {}: {e}", dest.display()))?;

            tracing::info!(
                "P2P: Restored version {} of {doc_type}/{file_path} to disk",
                version_index
            );
            Ok(())
        }
        _ => Err("No active team mode".to_string()),
    }
}
