use crate::commands::oss_sync::*;
use crate::commands::oss_types::*;
use crate::commands::p2p_state::IrohState;
#[cfg(feature = "p2p")]
use crate::commands::team_p2p::get_node_id;
#[allow(unused_imports)]
use crate::commands::TEAMCLAW_DIR;

use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use tauri::State;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Get the P2P node ID to use as the unified device identity.
async fn get_p2p_node_id(iroh_state: &State<'_, IrohState>) -> Result<String, String> {
    let guard = iroh_state.lock().await;
    #[cfg(feature = "p2p")]
    {
        let node = guard
            .as_ref()
            .ok_or("P2P node not running. Please wait for the app to fully initialize.")?;
        Ok(get_node_id(node))
    }
    #[cfg(not(feature = "p2p"))]
    {
        let _ = guard;
        Err("P2P feature is not enabled".to_string())
    }
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
    getrandom::getrandom(&mut buf).map_err(|e| format!("Failed to generate random bytes: {e}"))?;
    Ok(hex::encode(buf))
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn oss_create_team(
    state: State<'_, OssSyncState>,
    iroh_state: State<'_, IrohState>,
    app_handle: tauri::AppHandle,
    workspace_path: String,
    team_name: String,
    owner_name: String,
    owner_email: String,
    team_endpoint: String,
    force_path_style: bool,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
) -> Result<OssTeamInfo, String> {
    let node_id = get_p2p_node_id(&iroh_state).await?;
    let team_secret = generate_team_secret()?;

    // Write LLM config to .teamclaw/teamclaw.json
    let llm_config = super::team::build_llm_config(llm_base_url, llm_model, llm_model_name);
    super::team::write_llm_config(&workspace_path, Some(&llm_config))?;
    info!(
        "oss_create_team: wrote LLM config to {}/{}",
        super::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME
    );

    // Scaffold teamclaw-team directory with default structure
    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    super::team::scaffold_team_dir(&team_dir)?;

    // Create a temporary manager with empty team_id to call FC /register
    let mut manager = OssSyncManager::new(
        String::new(), // team_id not yet known
        node_id.clone(),
        team_secret.clone(),
        team_endpoint.clone(),
        force_path_style,
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
        team_endpoint.clone(),
        force_path_style,
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
    manager
        .upload_members_manifest(&manifest)
        .await
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
        team_endpoint: team_endpoint.clone(),
        force_path_style,
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

    // Fire-and-forget: register team + owner key in LiteLLM via FC (FC then calls LiteLLM).
    // Logs here are from the desktop app; LiteLLM access logs show the FC server, not the client.
    info!(
        "oss_create_team: scheduling LiteLLM via FC (POST …/ai/setup-team + …/ai/add-member) at {}",
        team_endpoint
    );
    {
        let fc_endpoint = team_endpoint.clone();
        let fc_team_id = team_id.clone();
        let fc_team_secret = team_secret.clone();
        let fc_team_name = team_name.clone();
        let fc_node_id = node_id.clone();
        let fc_owner_name = owner_name.clone();
        tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());
            let setup_url = format!("{}/ai/setup-team", fc_endpoint.trim_end_matches('/'));
            let add_url = format!("{}/ai/add-member", fc_endpoint.trim_end_matches('/'));
            tracing::info!("LiteLLM via FC: requesting {}", setup_url);
            // Setup team in LiteLLM
            let setup_body = serde_json::json!({
                "teamId": fc_team_id,
                "teamSecret": fc_team_secret,
                "teamName": fc_team_name,
            });
            match client
                .post(&setup_url)
                .json(&setup_body)
                .send()
                .await
            {
                Ok(r) => tracing::info!("LiteLLM via FC: setup-team HTTP status={}", r.status()),
                Err(e) => tracing::warn!("LiteLLM via FC: setup-team request failed: {e}"),
            }
            // Add owner key
            tracing::info!("LiteLLM via FC: requesting {}", add_url);
            let member_body = serde_json::json!({
                "teamId": fc_team_id,
                "teamSecret": fc_team_secret,
                "nodeId": fc_node_id,
                "memberName": fc_owner_name,
            });
            match client
                .post(&add_url)
                .json(&member_body)
                .send()
                .await
            {
                Ok(r) => tracing::info!("LiteLLM via FC: add-member (owner) HTTP status={}", r.status()),
                Err(e) => tracing::warn!("LiteLLM via FC: add-member (owner) request failed: {e}"),
            }
        });
    }

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
    iroh_state: State<'_, IrohState>,
    app_handle: tauri::AppHandle,
    workspace_path: String,
    team_id: String,
    team_secret: String,
    team_endpoint: String,
    force_path_style: bool,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
) -> Result<OssJoinResult, String> {
    let node_id = get_p2p_node_id(&iroh_state).await?;

    // Create manager and call FC /token
    let mut manager = OssSyncManager::new(
        team_id.clone(),
        node_id.clone(),
        team_secret.clone(),
        team_endpoint.clone(),
        force_path_style,
        workspace_path.clone(),
        Duration::from_secs(300),
        Some(app_handle.clone()),
    );

    let body = serde_json::json!({
        "teamId": team_id,
        "teamSecret": team_secret,
        "nodeId": node_id,
    });
    let resp = manager
        .call_fc("/token", &body)
        .await
        .map_err(|e| format!("FC /token failed: {e}"))?;
    manager.set_credentials(resp.credentials.clone(), resp.oss.clone());

    let role: MemberRole =
        serde_json::from_str(&format!("\"{}\"", resp.role)).unwrap_or(MemberRole::Editor);
    manager.set_role(role.clone());

    // Read _meta/team.json BEFORE member check (both paths need team_name)
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

    // Check if device is in members manifest
    match manager.check_member_authorized(&node_id).await {
        Ok(_authorized_role) => {
            // Device is authorized, proceed with sync
        }
        Err(_) => {
            // Not a member — return NotMember so frontend can show application dialog
            return Ok(OssJoinResult::NotMember { node_id, team_name });
        }
    }

    // Scaffold teamclaw-team directory
    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    if !std::path::Path::new(&team_dir).exists() {
        super::team::scaffold_team_dir(&team_dir)?;
    }

    // Write LLM config to .teamclaw/teamclaw.json
    let llm_config = super::team::build_llm_config(llm_base_url, llm_model, llm_model_name);
    super::team::write_llm_config(&workspace_path, Some(&llm_config))?;

    // Run initial sync
    manager.initial_sync().await?;

    // Save config + keyring
    let config = OssTeamConfig {
        enabled: true,
        team_id: team_id.clone(),
        team_endpoint: team_endpoint.clone(),
        force_path_style,
        last_sync_at: None,
        poll_interval_secs: 300,
    };
    write_oss_config(&workspace_path, &config)?;
    save_team_secret(&team_id, &team_secret)?;

    // Clear any pending application
    let _ = clear_pending_application(&workspace_path);

    // Store manager in state, start poll loop
    {
        let mut guard = state.manager.lock().await;
        *guard = Some(manager);
    }
    start_poll_loop(&state).await;

    info!("Joined OSS team: {team_id}");

    // Fire-and-forget: create LiteLLM key for joining member via FC
    info!(
        "oss_join_team: scheduling LiteLLM add-member via FC at {}",
        team_endpoint
    );
    {
        let fc_endpoint = team_endpoint.clone();
        let fc_team_id = team_id.clone();
        let fc_team_secret = team_secret.clone();
        let fc_node_id = node_id.clone();
        tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());
            let add_url = format!("{}/ai/add-member", fc_endpoint.trim_end_matches('/'));
            tracing::info!("LiteLLM via FC: requesting {}", add_url);
            let body = serde_json::json!({
                "teamId": fc_team_id,
                "teamSecret": fc_team_secret,
                "nodeId": fc_node_id,
            });
            match client
                .post(&add_url)
                .json(&body)
                .send()
                .await
            {
                Ok(r) => tracing::info!("LiteLLM via FC: add-member (join) HTTP status={}", r.status()),
                Err(e) => tracing::warn!("LiteLLM via FC: add-member (join) request failed: {e}"),
            }
        });
    }

    Ok(OssJoinResult::Joined {
        info: OssTeamInfo {
            team_id,
            team_secret: None,
            team_name,
            owner_name,
            role,
        },
    })
}

#[tauri::command]
pub async fn oss_restore_sync(
    state: State<'_, OssSyncState>,
    iroh_state: State<'_, IrohState>,
    app_handle: tauri::AppHandle,
    workspace_path: String,
    team_id: String,
) -> Result<OssTeamInfo, String> {
    let team_secret = load_team_secret(&team_id)?;
    let node_id = get_p2p_node_id(&iroh_state).await?;

    // Read existing config for team_endpoint and poll_interval
    let config = read_oss_config(&workspace_path)
        .ok_or_else(|| format!("No OSS config found in {}", super::CONFIG_FILE_NAME))?;

    let mut manager = OssSyncManager::new(
        team_id.clone(),
        node_id.clone(),
        team_secret.clone(),
        config.team_endpoint.clone(),
        config.force_path_style,
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

    let role: MemberRole =
        serde_json::from_str(&format!("\"{}\"", resp.role)).unwrap_or(MemberRole::Editor);
    manager.set_role(role.clone());

    // Restore from local snapshots, then pull remote, then reconcile disk.
    // write_doc_to_disk must always run so that files the user added while
    // the app was closed are absorbed into the LoroDoc (even when there are
    // no new remote keys and pull_remote_changes returns early).
    for doc_type in DocType::all() {
        let _ = manager.restore_from_local_snapshot(doc_type);
        if let Err(e) = manager.pull_remote_changes(doc_type).await {
            warn!("Restore pull for {:?} failed: {}", doc_type, e);
        }
        if let Err(e) = manager.write_doc_to_disk(doc_type) {
            warn!("Restore write_doc_to_disk for {:?} failed: {}", doc_type, e);
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
        team_secret: Some(team_secret),
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
    // Prevent owner from leaving if there are other members
    {
        let guard = state.manager.lock().await;
        if let Some(ref mgr) = *guard {
            if mgr.role() == MemberRole::Owner {
                if let Ok(Some(manifest)) = mgr.download_members_manifest().await {
                    if manifest.members.len() > 1 {
                        return Err("团队还有其他成员，请先移除所有成员或转让管理员角色后再离开"
                            .to_string());
                    }
                }
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
        .join(super::CONFIG_FILE_NAME);

    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {e}", super::CONFIG_FILE_NAME))?;
        let mut json: Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {e}", super::CONFIG_FILE_NAME))?;

        if let Some(obj) = json.as_object_mut() {
            obj.remove("oss");
        }

        let output = serde_json::to_string_pretty(&json)
            .map_err(|e| format!("Failed to serialize {}: {e}", super::CONFIG_FILE_NAME))?;
        std::fs::write(&config_path, output)
            .map_err(|e| format!("Failed to write {}: {e}", super::CONFIG_FILE_NAME))?;
    }

    info!("Left OSS team");
    Ok(())
}

#[tauri::command]
pub async fn oss_sync_now(state: State<'_, OssSyncState>) -> Result<SyncStatus, String> {
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
pub async fn oss_get_sync_status(state: State<'_, OssSyncState>) -> Result<SyncStatus, String> {
    let guard = state.manager.lock().await;
    let manager = guard
        .as_ref()
        .ok_or_else(|| "OSS sync not active".to_string())?;

    Ok(manager.get_sync_status())
}

#[tauri::command]
pub async fn oss_get_files_sync_status(
    state: State<'_, OssSyncState>,
    doc_type: Option<String>,
) -> Result<Vec<FileSyncStatus>, String> {
    let dt = match &doc_type {
        Some(s) => Some(parse_doc_type(s)?),
        None => None,
    };

    let guard = state.manager.lock().await;
    let manager = guard
        .as_ref()
        .ok_or_else(|| "OSS sync not active".to_string())?;

    manager.get_files_sync_status(dt)
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
pub async fn oss_get_team_config(workspace_path: String) -> Result<Option<OssTeamConfig>, String> {
    Ok(read_oss_config(&workspace_path))
}

#[tauri::command]
pub async fn oss_apply_team(
    iroh_state: State<'_, IrohState>,
    workspace_path: String,
    team_id: String,
    team_secret: String,
    team_endpoint: String,
    #[allow(unused)] force_path_style: bool,
    name: String,
    email: String,
    note: String,
) -> Result<(), String> {
    let node_id = get_p2p_node_id(&iroh_state).await?;

    // Get device info for the application
    let hostname = gethostname::gethostname().to_string_lossy().to_string();
    let platform = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();

    // Call FC /apply
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let body = serde_json::json!({
        "teamId": team_id,
        "teamSecret": team_secret,
        "nodeId": node_id,
        "name": name,
        "email": email,
        "note": note,
        "platform": platform,
        "arch": arch,
        "hostname": hostname,
    });

    let url = format!("{}/apply", team_endpoint);
    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to call FC /apply: {e}"))?;

    if !response.status().is_success() {
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "unknown".to_string());
        return Err(format!("FC /apply failed: {text}"));
    }

    // Save pending application state locally
    let pending = PendingApplication {
        team_id: team_id.clone(),
        team_endpoint,
        applied_at: chrono::Utc::now().to_rfc3339(),
    };
    write_pending_application(&workspace_path, &pending)?;

    // Save team secret so we can re-check later
    save_team_secret(&team_id, &team_secret)?;

    info!("Application submitted for team: {team_id}");
    Ok(())
}

#[tauri::command]
pub async fn oss_get_pending_application(
    workspace_path: String,
) -> Result<Option<PendingApplication>, String> {
    Ok(read_pending_application(&workspace_path))
}

#[tauri::command]
pub async fn oss_cancel_application(workspace_path: String) -> Result<(), String> {
    clear_pending_application(&workspace_path)
}

#[tauri::command]
pub async fn oss_approve_application(
    state: State<'_, OssSyncState>,
    node_id: String,
    name: String,
    _email: String,
    role: String,
) -> Result<(), String> {
    let guard = state.manager.lock().await;
    let manager = guard
        .as_ref()
        .ok_or_else(|| "OSS sync not active".to_string())?;

    // Add to members manifest (add_member takes a TeamMember struct)
    let member_role: MemberRole =
        serde_json::from_str(&format!("\"{}\"", role)).unwrap_or(MemberRole::Editor);
    let member = TeamMember {
        node_id: node_id.clone(),
        name: name.clone(),
        role: member_role,
        label: String::new(),
        platform: String::new(),
        arch: String::new(),
        hostname: String::new(),
        added_at: chrono::Utc::now().to_rfc3339(),
    };
    manager.add_member(member).await?;

    // Delete application file from S3
    let app_key = format!(
        "teams/{}/_meta/applications/{}.json",
        manager.team_id(),
        node_id
    );
    let _ = manager.s3_delete(&app_key).await;

    info!("Approved application for nodeId: {node_id}");
    Ok(())
}
