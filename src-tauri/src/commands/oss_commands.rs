use crate::commands::oss_types::*;
use crate::commands::oss_sync::*;
use crate::commands::TEAMCLAW_DIR;

use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use tauri::State;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Get or create a stable node ID for this device, stored in teamclaw.json under oss.nodeId.
fn get_or_create_node_id(workspace_path: &str) -> Result<String, String> {
    let config_path = Path::new(workspace_path)
        .join(TEAMCLAW_DIR)
        .join("teamclaw.json");

    let mut json: Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read teamclaw.json: {e}"))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse teamclaw.json: {e}"))?
    } else {
        Value::Object(serde_json::Map::new())
    };

    // Check if oss.nodeId already exists
    if let Some(oss) = json.get("oss") {
        if let Some(Value::String(node_id)) = oss.get("nodeId") {
            if !node_id.is_empty() {
                return Ok(node_id.clone());
            }
        }
    }

    // Generate a new node ID
    let node_id = nanoid::nanoid!(21);

    // Save it to teamclaw.json
    let root = json
        .as_object_mut()
        .ok_or_else(|| "teamclaw.json root is not an object".to_string())?;

    if !root.contains_key("oss") {
        root.insert("oss".to_string(), Value::Object(serde_json::Map::new()));
    }

    root.get_mut("oss")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "oss key is not an object".to_string())?
        .insert("nodeId".to_string(), Value::String(node_id.clone()));

    // Ensure parent dir exists
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {e}"))?;
    }

    let output = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize teamclaw.json: {e}"))?;
    std::fs::write(&config_path, output)
        .map_err(|e| format!("Failed to write teamclaw.json: {e}"))?;

    Ok(node_id)
}

fn parse_doc_type(s: &str) -> Result<DocType, String> {
    match s {
        "skills" => Ok(DocType::Skills),
        "mcp" => Ok(DocType::Mcp),
        "knowledge" => Ok(DocType::Knowledge),
        _ => Err(format!("Unknown doc type: {s}")),
    }
}

async fn start_poll_loop(state: &OssSyncState) {
    let manager_arc = state.manager.clone();
    let handle = tokio::spawn(async move {
        OssSyncManager::poll_loop(manager_arc).await;
    });
    let mut poll_guard = state.poll_handle.lock().await;
    if let Some(old_handle) = poll_guard.take() {
        old_handle.abort();
    }
    *poll_guard = Some(handle);
}

/// Generate a 32-byte random hex string for use as a team secret.
fn generate_team_secret() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf)
        .map_err(|e| format!("Failed to generate random bytes: {e}"))?;
    Ok(hex::encode(buf))
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn oss_create_team(
    state: State<'_, OssSyncState>,
    app_handle: tauri::AppHandle,
    workspace_path: String,
    team_name: String,
    owner_name: String,
    owner_email: String,
    fc_endpoint: String,
) -> Result<OssTeamInfo, String> {
    let node_id = get_or_create_node_id(&workspace_path)?;
    let team_secret = generate_team_secret()?;

    // Create a temporary manager with empty team_id to call FC /register
    let mut manager = OssSyncManager::new(
        String::new(), // team_id not yet known
        node_id.clone(),
        team_secret.clone(),
        fc_endpoint.clone(),
        workspace_path.clone(),
        Duration::from_secs(300),
        Some(app_handle.clone()),
    );

    // Call FC /register
    let body = serde_json::json!({
        "teamSecret": team_secret,
        "ownerNodeId": node_id,
        "teamName": team_name,
        "ownerName": owner_name,
        "ownerEmail": owner_email,
    });

    info!("oss_create_team: calling FC /register...");
    let resp = manager.call_fc("/register", &body).await?;
    let team_id = resp
        .team_id
        .clone()
        .ok_or_else(|| "FC /register did not return a teamId".to_string())?;
    info!("oss_create_team: FC /register returned team_id={team_id}");

    // Update manager with returned team_id and credentials
    manager = OssSyncManager::new(
        team_id.clone(),
        node_id.clone(),
        team_secret.clone(),
        fc_endpoint.clone(),
        workspace_path.clone(),
        Duration::from_secs(300),
        Some(app_handle.clone()),
    );
    manager.set_credentials(resp.credentials.clone(), resp.oss.clone());
    manager.set_role(MemberRole::Owner);

    // Scan existing team_dir for content, do initial upload
    info!("oss_create_team: uploading local changes...");
    for doc_type in DocType::all() {
        if let Err(e) = manager.upload_local_changes(doc_type).await {
            warn!("Initial upload for {:?} failed: {}", doc_type, e);
        }
    }
    info!("oss_create_team: local changes uploaded");

    // Upload initial members manifest to _team/members.json
    let owner_member = TeamMember {
        node_id: node_id.clone(),
        name: owner_name.clone(),
        role: MemberRole::Owner,
        label: String::new(),
        platform: String::new(),
        arch: String::new(),
        hostname: String::new(),
        added_at: chrono::Utc::now().to_rfc3339(),
    };
    let manifest = TeamManifest {
        owner_node_id: node_id.clone(),
        members: vec![owner_member],
    };
    manager.upload_members_manifest(&manifest).await
        .map_err(|e| format!("Failed to upload members manifest: {}", e))?;

    // Upload team.json to _meta/
    let team_json = serde_json::json!({
        "schemaVersion": 1,
        "teamId": team_id,
        "teamName": team_name,
        "ownerName": owner_name,
        "ownerEmail": owner_email,
        "createdAt": chrono::Utc::now().to_rfc3339(),
    });
    let team_bytes = serde_json::to_vec_pretty(&team_json)
        .map_err(|e| format!("Failed to serialize team.json: {e}"))?;
    let team_key = format!("teams/{}/_meta/team.json", team_id);
    info!("oss_create_team: uploading team.json...");
    manager.s3_put(&team_key, &team_bytes).await?;
    info!("oss_create_team: team.json uploaded, saving config...");

    // Save config
    let config = OssTeamConfig {
        enabled: true,
        team_id: team_id.clone(),
        fc_endpoint: fc_endpoint.clone(),
        last_sync_at: None,
        poll_interval_secs: 300,
    };
    write_oss_config(&workspace_path, &config)?;
    save_team_secret(&team_id, &team_secret)?;

    // Store manager in state, start poll loop
    {
        let mut guard = state.manager.lock().await;
        *guard = Some(manager);
    }
    start_poll_loop(&state).await;

    info!("OSS team created: {team_id}");

    Ok(OssTeamInfo {
        team_id,
        team_secret: Some(team_secret),
        team_name,
        owner_name,
        role: MemberRole::Owner,
    })
}

#[tauri::command]
pub async fn oss_join_team(
    state: State<'_, OssSyncState>,
    app_handle: tauri::AppHandle,
    workspace_path: String,
    team_id: String,
    team_secret: String,
    fc_endpoint: String,
) -> Result<OssTeamInfo, String> {
    let node_id = get_or_create_node_id(&workspace_path)?;

    // Create manager and call FC /token
    let mut manager = OssSyncManager::new(
        team_id.clone(),
        node_id.clone(),
        team_secret.clone(),
        fc_endpoint.clone(),
        workspace_path.clone(),
        Duration::from_secs(300),
        Some(app_handle.clone()),
    );

    let body = serde_json::json!({
        "teamId": team_id,
        "teamSecret": team_secret,
        "nodeId": node_id,
    });
    let resp = manager.call_fc("/token", &body).await
        .map_err(|_| "Ticket 不正确，请检查后重试".to_string())?;
    manager.set_credentials(resp.credentials.clone(), resp.oss.clone());

    let role: MemberRole = serde_json::from_str(&format!("\"{}\"", resp.role))
        .unwrap_or(MemberRole::Editor);
    manager.set_role(role.clone());

    // Two-step NodeId validation: check device is in the members manifest
    match manager.check_member_authorized(&node_id).await {
        Ok(_authorized_role) => {
            // Device is authorized, proceed with sync
        }
        Err(_) => {
            return Err("你的设备未被添加到团队中，请联系团队 Owner".to_string());
        }
    }

    // Run initial sync
    manager.initial_sync().await?;

    // Read _meta/team.json from OSS to get team_name and owner_name
    let team_key = format!("teams/{}/_meta/team.json", team_id);
    let team_data = manager.s3_get(&team_key).await.unwrap_or_default();
    let team_meta: Value = serde_json::from_slice(&team_data).unwrap_or(Value::Null);
    let team_name = team_meta
        .get("teamName")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown Team")
        .to_string();
    let owner_name = team_meta
        .get("ownerName")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();

    // Save config + keyring
    let config = OssTeamConfig {
        enabled: true,
        team_id: team_id.clone(),
        fc_endpoint: fc_endpoint.clone(),
        last_sync_at: None,
        poll_interval_secs: 300,
    };
    write_oss_config(&workspace_path, &config)?;
    save_team_secret(&team_id, &team_secret)?;

    // Store manager in state, start poll loop
    {
        let mut guard = state.manager.lock().await;
        *guard = Some(manager);
    }
    start_poll_loop(&state).await;

    info!("Joined OSS team: {team_id}");

    Ok(OssTeamInfo {
        team_id,
        team_secret: None,
        team_name,
        owner_name,
        role,
    })
}

#[tauri::command]
pub async fn oss_restore_sync(
    state: State<'_, OssSyncState>,
    app_handle: tauri::AppHandle,
    workspace_path: String,
    team_id: String,
) -> Result<OssTeamInfo, String> {
    let team_secret = load_team_secret(&team_id)?;
    let node_id = get_or_create_node_id(&workspace_path)?;

    // Read existing config for fc_endpoint and poll_interval
    let config = read_oss_config(&workspace_path)
        .ok_or_else(|| "No OSS config found in teamclaw.json".to_string())?;

    let mut manager = OssSyncManager::new(
        team_id.clone(),
        node_id.clone(),
        team_secret.clone(),
        config.fc_endpoint.clone(),
        workspace_path.clone(),
        Duration::from_secs(config.poll_interval_secs),
        Some(app_handle.clone()),
    );

    // Call FC /token
    let body = serde_json::json!({
        "teamId": team_id,
        "teamSecret": team_secret,
        "nodeId": node_id,
    });
    let resp = manager.call_fc("/token", &body).await?;
    manager.set_credentials(resp.credentials.clone(), resp.oss.clone());

    let role: MemberRole = serde_json::from_str(&format!("\"{}\"", resp.role))
        .unwrap_or(MemberRole::Editor);
    manager.set_role(role.clone());

    // Restore from local snapshots, then pull remote
    for doc_type in DocType::all() {
        let _ = manager.restore_from_local_snapshot(doc_type);
        if let Err(e) = manager.pull_remote_changes(doc_type).await {
            warn!("Restore pull for {:?} failed: {}", doc_type, e);
        }
    }

    // Read _meta/team.json for display info
    let team_key = format!("teams/{}/_meta/team.json", team_id);
    let team_data = manager.s3_get(&team_key).await.unwrap_or_default();
    let team_meta: Value = serde_json::from_slice(&team_data).unwrap_or(Value::Null);
    let team_name = team_meta
        .get("teamName")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown Team")
        .to_string();
    let owner_name = team_meta
        .get("ownerName")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();

    // Store manager in state, start poll loop
    {
        let mut guard = state.manager.lock().await;
        *guard = Some(manager);
    }
    start_poll_loop(&state).await;

    info!("Restored OSS sync for team: {team_id}");

    Ok(OssTeamInfo {
        team_id,
        team_secret: None,
        team_name,
        owner_name,
        role,
    })
}

#[tauri::command]
pub async fn oss_leave_team(
    state: State<'_, OssSyncState>,
    workspace_path: String,
) -> Result<(), String> {
    // Prevent owner from leaving — must transfer ownership first
    {
        let guard = state.manager.lock().await;
        if let Some(ref mgr) = *guard {
            if mgr.role() == MemberRole::Owner {
                return Err("团队创建者不能离开团队，请先转让管理员角色".to_string());
            }
        }
    }

    // Stop poll loop
    {
        let mut poll_guard = state.poll_handle.lock().await;
        if let Some(handle) = poll_guard.take() {
            handle.abort();
        }
    }

    // Clear manager from state
    {
        let mut guard = state.manager.lock().await;
        *guard = None;
    }

    // Read config to get team_id, then clean up
    if let Some(config) = read_oss_config(&workspace_path) {
        let _ = delete_team_secret(&config.team_id);
    }

    // Disable OSS in teamclaw.json
    let config_path = Path::new(&workspace_path)
        .join(TEAMCLAW_DIR)
        .join("teamclaw.json");

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read teamclaw.json: {e}"))?;
        let mut json: Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse teamclaw.json: {e}"))?;

        if let Some(obj) = json.as_object_mut() {
            obj.remove("oss");
        }

        let output = serde_json::to_string_pretty(&json)
            .map_err(|e| format!("Failed to serialize teamclaw.json: {e}"))?;
        std::fs::write(&config_path, output)
            .map_err(|e| format!("Failed to write teamclaw.json: {e}"))?;
    }

    info!("Left OSS team");
    Ok(())
}

#[tauri::command]
pub async fn oss_sync_now(
    state: State<'_, OssSyncState>,
) -> Result<SyncStatus, String> {
    let mut guard = state.manager.lock().await;
    let manager = guard
        .as_mut()
        .ok_or_else(|| "OSS sync not active".to_string())?;

    manager.refresh_token_if_needed().await?;

    for doc_type in DocType::all() {
        manager.upload_local_changes(doc_type).await?;
        manager.pull_remote_changes(doc_type).await?;
        let _ = manager.persist_local_snapshot(doc_type);
    }

    let now = chrono::Utc::now().to_rfc3339();
    manager.set_last_sync_at(Some(now));

    Ok(manager.get_sync_status())
}

#[tauri::command]
pub async fn oss_get_sync_status(
    state: State<'_, OssSyncState>,
) -> Result<SyncStatus, String> {
    let guard = state.manager.lock().await;
    let manager = guard
        .as_ref()
        .ok_or_else(|| "OSS sync not active".to_string())?;

    Ok(manager.get_sync_status())
}

#[tauri::command]
pub async fn oss_create_snapshot(
    state: State<'_, OssSyncState>,
    doc_type: String,
) -> Result<(), String> {
    let dt = parse_doc_type(&doc_type)?;
    let mut guard = state.manager.lock().await;
    let manager = guard
        .as_mut()
        .ok_or_else(|| "OSS sync not active".to_string())?;

    manager.create_snapshot(dt).await
}

#[tauri::command]
pub async fn oss_cleanup_updates(
    state: State<'_, OssSyncState>,
    doc_type: String,
) -> Result<CleanupResult, String> {
    let dt = parse_doc_type(&doc_type)?;
    let mut guard = state.manager.lock().await;
    let manager = guard
        .as_mut()
        .ok_or_else(|| "OSS sync not active".to_string())?;

    manager.cleanup_old_updates(dt).await
}

#[tauri::command]
pub async fn oss_update_members(
    state: State<'_, OssSyncState>,
    members: Vec<TeamMember>,
) -> Result<(), String> {
    let guard = state.manager.lock().await;
    let manager = guard
        .as_ref()
        .ok_or_else(|| "OSS sync not active".to_string())?;

    let members_json = serde_json::json!({
        "schemaVersion": 1,
        "members": members,
    });
    let members_bytes = serde_json::to_vec_pretty(&members_json)
        .map_err(|e| format!("Failed to serialize members.json: {e}"))?;

    let team_id = manager.team_id();
    let meta_key = format!("teams/{}/_meta/members.json", team_id);
    manager.s3_put(&meta_key, &members_bytes).await
}

#[tauri::command]
pub async fn oss_reset_team_secret(
    state: State<'_, OssSyncState>,
    _workspace_path: String,
) -> Result<String, String> {
    let new_secret = generate_team_secret()?;

    let guard = state.manager.lock().await;
    let manager = guard
        .as_ref()
        .ok_or_else(|| "OSS sync not active".to_string())?;

    let team_id = manager.team_id().to_string();
    let old_secret = load_team_secret(&team_id)?;

    let body = serde_json::json!({
        "teamId": team_id,
        "oldSecret": old_secret,
        "newSecret": new_secret,
    });
    manager.call_fc("/reset-secret", &body).await?;

    // Update keyring with new secret
    save_team_secret(&team_id, &new_secret)?;

    info!("Team secret reset for team: {team_id}");
    Ok(new_secret)
}

#[tauri::command]
pub async fn oss_get_team_config(
    workspace_path: String,
) -> Result<Option<OssTeamConfig>, String> {
    Ok(read_oss_config(&workspace_path))
}
