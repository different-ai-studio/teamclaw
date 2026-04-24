// P2P team sync — thin Tauri command wrappers delegating to teamclaw_p2p crate.

// Re-export types so existing consumers (lib.rs, oss_commands, telemetry, team_unified) still compile.
pub use teamclaw_p2p::{
    // Functions
    add_member_to_team,
    check_join_authorization,
    clear_p2p_and_team_dir,
    create_team,
    disconnect_source_for_workspace,
    disconnected_engine_snapshot,
    dissolve_team_for_workspace,
    get_device_metadata,
    get_files_sync_status,
    get_node_id,
    join_team_drive,
    leave_team_for_workspace,
    publish_team_drive,
    query_skills_leaderboard,
    read_members_manifest,
    read_p2p_config,
    reconnect_team_for_workspace,
    remove_member_from_team,
    rotate_namespace,
    update_member_role,
    write_members_manifest,
    write_p2p_config,
    // Types
    DeviceInfo,
    EngineSnapshot,
    EngineStatus,
    IrohNode,
    IrohState,
    P2pConfig,
    // Event handler trait
    P2pEventHandler,
    P2pSyncStatus,
    PeerConnection,
    PeerInfo,
    SkillsContribution,
    StreamHealth,
    SyncEngine,
    SyncEngineState,
};

use std::sync::Arc;
use tauri::Manager;

use super::team_unified::{MemberRole, TeamMember};

// ─── Event handler implementation ────────────────────────────────────────

/// Tauri-based implementation of P2pEventHandler that emits events to the frontend.
struct TauriEventHandler {
    app: tauri::AppHandle,
}

impl teamclaw_p2p::P2pEventHandler for TauriEventHandler {
    fn emit_engine_state(&self, snapshot: &EngineSnapshot) {
        use tauri::Emitter;
        let _ = self.app.emit("p2p:engine-state", snapshot);
    }

    fn emit_secrets_changed(&self) {
        use tauri::Emitter;
        let _ = self.app.emit("secrets-changed", ());
    }

    fn reload_shared_secrets(&self) {
        let shared_state = self
            .app
            .state::<crate::commands::shared_secrets::SharedSecretsState>();
        if let Err(e) = crate::commands::shared_secrets::load_all_secrets(&shared_state) {
            eprintln!("[P2P] Failed to reload shared secrets: {}", e);
        }
    }

    fn emit_member_left(&self, node_id: &str, name: &str) {
        use tauri::Emitter;
        let _ = self.app.emit(
            "team:member-left",
            serde_json::json!({
                "nodeId": node_id,
                "name": name,
            }),
        );
    }

    fn emit_team_dissolved(&self) {
        use tauri::Emitter;
        let _ = self.app.emit("team:dissolved", serde_json::json!({}));
    }

    fn emit_members_changed(&self) {
        use tauri::Emitter;
        let _ = self.app.emit("team:members-changed", serde_json::json!({}));
    }

    fn emit_kicked(&self, node_id: &str) {
        use tauri::Emitter;
        let _ = self.app.emit(
            "team:kicked",
            serde_json::json!({
                "nodeId": node_id,
            }),
        );
    }

    fn emit_role_changed(&self, role: &MemberRole) {
        use tauri::Emitter;
        let _ = self.app.emit(
            "team:role-changed",
            serde_json::json!({
                "role": role,
            }),
        );
    }
}

fn make_event_handler(app: &tauri::AppHandle) -> Arc<dyn P2pEventHandler> {
    Arc::new(TauriEventHandler { app: app.clone() })
}

fn make_event_handler_opt(app: Option<tauri::AppHandle>) -> Option<Arc<dyn P2pEventHandler>> {
    app.map(|a| make_event_handler(&a))
}

// ─── Helper: config constants ────────────────────────────────────────────

fn teamclaw_dir() -> &'static str {
    super::TEAMCLAW_DIR
}

fn config_file_name() -> &'static str {
    super::CONFIG_FILE_NAME
}

fn team_repo_dir() -> &'static str {
    super::TEAM_REPO_DIR
}

async fn ensure_p2p_node_started<'a, T, F, Fut>(
    slot: &'a mut Option<T>,
    context: &'static str,
    starter: F,
) -> Result<&'a mut T, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    if slot.is_none() {
        let node = starter()
            .await
            .map_err(|e| format!("Failed to start P2P node for {}: {}", context, e))?;
        *slot = Some(node);
        eprintln!("[P2P] iroh node started on-demand for {}", context);
    }

    slot.as_mut()
        .ok_or_else(|| format!("P2P node not running for {}", context))
}

// ─── Tauri Commands ─────────────────────────────────────────────────────

#[tauri::command]
pub fn get_device_info() -> Result<DeviceInfo, String> {
    let mut info = get_device_metadata();
    info.node_id = super::oss_commands::get_device_id()?;
    Ok(info)
}

#[tauri::command]
pub fn get_device_node_id() -> Result<String, String> {
    super::oss_commands::get_device_id()
}

#[tauri::command]
pub fn get_device_hostname() -> String {
    get_device_metadata().hostname
}

#[tauri::command]
pub async fn p2p_leave_team(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;
    leave_team_for_workspace(
        iroh_state.inner(),
        &workspace_path,
        teamclaw_dir(),
        config_file_name(),
        team_repo_dir(),
    )
    .await
}

#[tauri::command]
pub async fn p2p_disconnect_source(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;
    disconnect_source_for_workspace(
        iroh_state.inner(),
        &workspace_path,
        teamclaw_dir(),
        config_file_name(),
        team_repo_dir(),
    )
    .await
}

#[tauri::command]
pub async fn p2p_dissolve_team(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;
    dissolve_team_for_workspace(
        iroh_state.inner(),
        &workspace_path,
        teamclaw_dir(),
        config_file_name(),
        team_repo_dir(),
    )
    .await
}

#[tauri::command]
pub async fn team_add_member(
    node_id: String,
    name: String,
    role: Option<String>,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    let caller_id = get_node_id(node);
    drop(guard);

    let member_role = match role.as_deref() {
        Some("viewer") => MemberRole::Viewer,
        _ => MemberRole::Editor,
    };

    let member = TeamMember {
        node_id,
        name,
        role: member_role,
        shortcuts_role: Vec::new(),
        label: String::new(),
        platform: String::new(),
        arch: String::new(),
        hostname: String::new(),
        added_at: chrono::Utc::now().to_rfc3339(),
    };

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir());
    add_member_to_team(
        &workspace_path,
        &team_dir,
        &caller_id,
        member,
        teamclaw_dir(),
        config_file_name(),
    )?;

    // Also write updated manifest into the doc so it syncs
    let guard = iroh_state.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(doc) = &node.active_doc {
            let manifest_path =
                format!("{}/{}/_team/members.json", workspace_path, team_repo_dir());
            match std::fs::read(&manifest_path) {
                Ok(content) => {
                    if let Err(e) = doc
                        .set_bytes(node.author, "_team/members.json", content)
                        .await
                    {
                        eprintln!("[Team] Failed to write members.json to iroh doc: {}", e);
                        return Err(format!("Member added locally but failed to sync: {}", e));
                    }
                    eprintln!("[Team] Updated members.json synced to iroh doc");
                }
                Err(e) => {
                    eprintln!("[Team] Failed to read members.json from disk: {}", e);
                    return Err(format!("Member added but manifest file unreadable: {}", e));
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn team_remove_member(
    node_id: String,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    let caller_id = get_node_id(node);
    drop(guard);

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir());
    remove_member_from_team(
        &workspace_path,
        &team_dir,
        &caller_id,
        &node_id,
        teamclaw_dir(),
        config_file_name(),
    )?;

    // Sync manifest to doc
    let guard = iroh_state.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(doc) = &node.active_doc {
            let manifest_path =
                format!("{}/{}/_team/members.json", workspace_path, team_repo_dir());
            match std::fs::read(&manifest_path) {
                Ok(content) => {
                    if let Err(e) = doc
                        .set_bytes(node.author, "_team/members.json", content)
                        .await
                    {
                        eprintln!("[Team] Failed to write members.json to iroh doc: {}", e);
                    }
                }
                Err(e) => {
                    eprintln!("[Team] Failed to read members.json from disk: {}", e);
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn team_update_member_role(
    node_id: String,
    role: String,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let new_role = match role.as_str() {
        "viewer" => MemberRole::Viewer,
        "editor" => MemberRole::Editor,
        _ => return Err(format!("Invalid role: {}", role)),
    };

    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    let caller_node_id = get_node_id(node);
    drop(guard);

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir());
    update_member_role(
        &workspace_path,
        &team_dir,
        &caller_node_id,
        &node_id,
        new_role,
        teamclaw_dir(),
        config_file_name(),
    )?;

    // Sync manifest to doc
    let guard = iroh_state.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(doc) = &node.active_doc {
            let manifest_path =
                format!("{}/{}/_team/members.json", workspace_path, team_repo_dir());
            if let Ok(content) = std::fs::read(&manifest_path) {
                let _ = doc
                    .set_bytes(node.author, "_team/members.json", content)
                    .await;
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn p2p_check_team_dir(
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<serde_json::Value, String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir());
    let exists = std::path::Path::new(&team_dir).exists();
    let has_members = std::path::Path::new(&team_dir)
        .join("_team")
        .join("members.json")
        .exists();

    Ok(serde_json::json!({
        "exists": exists,
        "hasMembers": has_members,
    }))
}

#[tauri::command]
pub async fn p2p_create_team(
    app: tauri::AppHandle,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    llm_models: Option<String>,
    team_name: Option<String>,
    owner_name: Option<String>,
    owner_email: Option<String>,
    iroh_state: tauri::State<'_, IrohState>,
    engine_state: tauri::State<'_, SyncEngineState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut guard = iroh_state.lock().await;
    let node = ensure_p2p_node_started(&mut *guard, "team creation", IrohNode::new_default).await?;

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir());

    // Write LLM config (only if user chose to host LLM)
    let llm_config = crate::commands::team::build_llm_config(
        llm_base_url,
        llm_model,
        llm_model_name,
        llm_models,
    );
    crate::commands::team::write_llm_config(&workspace_path, llm_config.as_ref())?;

    create_team(
        node,
        &team_dir,
        &workspace_path,
        team_name,
        owner_name,
        owner_email,
        Some(make_event_handler(&app)),
        engine_state.inner().clone(),
        teamclaw_dir(),
        config_file_name(),
        team_repo_dir(),
    )
    .await
}

#[tauri::command]
pub async fn p2p_publish_drive(
    iroh_state: tauri::State<'_, IrohState>,
    engine_state: tauri::State<'_, SyncEngineState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut guard = iroh_state.lock().await;
    let node = ensure_p2p_node_started(
        &mut *guard,
        "publishing the team drive",
        IrohNode::new_default,
    )
    .await?;

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir());

    // If no active doc, create a team (first-time publish)
    if node.active_doc.is_none() {
        return create_team(
            node,
            &team_dir,
            &workspace_path,
            None,
            None,
            None,
            None,
            engine_state.inner().clone(),
            teamclaw_dir(),
            config_file_name(),
            team_repo_dir(),
        )
        .await;
    }

    publish_team_drive(
        node,
        &team_dir,
        &workspace_path,
        teamclaw_dir(),
        config_file_name(),
    )
    .await?;

    let config = read_p2p_config(&workspace_path, teamclaw_dir(), config_file_name())?;
    config
        .and_then(|c| c.doc_ticket)
        .ok_or_else(|| "No ticket available".to_string())
}

#[tauri::command]
pub async fn p2p_join_drive(
    app: tauri::AppHandle,
    ticket: String,
    #[allow(unused_variables)] label: String,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    llm_models: Option<String>,
    iroh_state: tauri::State<'_, IrohState>,
    engine_state: tauri::State<'_, SyncEngineState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut guard = iroh_state.lock().await;
    let node =
        ensure_p2p_node_started(&mut *guard, "joining a team drive", IrohNode::new_default).await?;

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir());
    let result = join_team_drive(
        node,
        &ticket,
        &team_dir,
        &workspace_path,
        Some(make_event_handler(&app)),
        engine_state.inner().clone(),
        teamclaw_dir(),
        config_file_name(),
        team_repo_dir(),
    )
    .await?;

    // Write LLM config (only if user chose to host LLM)
    let llm_config = crate::commands::team::build_llm_config(
        llm_base_url,
        llm_model,
        llm_model_name,
        llm_models,
    );
    crate::commands::team::write_llm_config(&workspace_path, llm_config.as_ref())?;

    Ok(result)
}

#[tauri::command]
pub async fn p2p_reconnect(
    app: tauri::AppHandle,
    iroh_state: tauri::State<'_, IrohState>,
    engine_state: tauri::State<'_, SyncEngineState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut guard = iroh_state.lock().await;
    let node =
        ensure_p2p_node_started(&mut *guard, "reconnecting to a team", IrohNode::new_default)
            .await?;
    reconnect_team_for_workspace(
        node,
        &workspace_path,
        Some(make_event_handler(&app)),
        engine_state.inner().clone(),
        teamclaw_dir(),
        config_file_name(),
        team_repo_dir(),
    )
    .await
}

#[tauri::command]
pub async fn p2p_rotate_ticket(
    iroh_state: tauri::State<'_, IrohState>,
    engine_state: tauri::State<'_, SyncEngineState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut guard = iroh_state.lock().await;
    let node = ensure_p2p_node_started(
        &mut *guard,
        "rotating the team ticket",
        IrohNode::new_default,
    )
    .await?;

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir());
    rotate_namespace(
        node,
        &team_dir,
        &workspace_path,
        engine_state.inner().clone(),
        teamclaw_dir(),
        config_file_name(),
        team_repo_dir(),
    )
    .await
}

#[tauri::command]
pub async fn get_p2p_config(
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<Option<P2pConfig>, String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;
    read_p2p_config(&workspace_path, teamclaw_dir(), config_file_name())
}

#[tauri::command]
pub async fn save_p2p_config(
    config: P2pConfig,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;
    write_p2p_config(
        &workspace_path,
        Some(&config),
        teamclaw_dir(),
        config_file_name(),
    )
}

#[tauri::command]
pub async fn p2p_node_status(
    engine_state: tauri::State<'_, SyncEngineState>,
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<EngineSnapshot, String> {
    let snapshot = {
        let eng = engine_state.lock().await;
        eng.snapshot()
    };

    let Ok(workspace_path) = crate::commands::opencode::current_workspace_path(&opencode_state)
    else {
        return Ok(disconnected_engine_snapshot(snapshot));
    };

    let config =
        read_p2p_config(&workspace_path, teamclaw_dir(), config_file_name())?.unwrap_or_default();
    let active_namespace = {
        let guard = iroh_state.lock().await;
        guard
            .as_ref()
            .and_then(|node| node.active_doc.as_ref().map(|doc| doc.id().to_string()))
    };

    let workspace_matches_active_doc =
        match (config.namespace_id.as_deref(), active_namespace.as_deref()) {
            (Some(config_ns), Some(active_ns)) => config_ns == active_ns,
            _ => false,
        };

    if workspace_matches_active_doc {
        Ok(snapshot)
    } else {
        Ok(disconnected_engine_snapshot(snapshot))
    }
}

#[tauri::command]
pub async fn p2p_sync_status(
    iroh_state: tauri::State<'_, IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<P2pSyncStatus, String> {
    use teamclaw_p2p::iroh_docs;

    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let config =
        read_p2p_config(&workspace_path, teamclaw_dir(), config_file_name())?.unwrap_or_default();
    let guard = iroh_state.lock().await;
    let connected = guard.as_ref().map_or(false, |n| {
        match (&n.active_doc, config.namespace_id.as_deref()) {
            (Some(doc), Some(config_ns)) => doc.id().to_string() == config_ns,
            _ => false,
        }
    });

    // Generate a fresh ticket from THIS member's perspective
    let member_ticket = if let Some(node) = guard.as_ref() {
        if let Some(doc) = &node.active_doc {
            match doc
                .share(
                    iroh_docs::api::protocol::ShareMode::Write,
                    iroh_docs::api::protocol::AddrInfoOptions::RelayAndAddresses,
                )
                .await
            {
                Ok(mut ticket) => {
                    let team_dir = format!("{}/{}", workspace_path, team_repo_dir());
                    let my_node_id = get_node_id(node);
                    let ep = node.endpoint();
                    let mut other_peers: Vec<teamclaw_p2p::iroh::EndpointAddr> = Vec::new();

                    if let Ok(Some(manifest)) = read_members_manifest(&team_dir) {
                        for member in &manifest.members {
                            if member.node_id == my_node_id {
                                continue;
                            }
                            if let Ok(id) = member.node_id.parse::<teamclaw_p2p::iroh::EndpointId>()
                            {
                                let mut addrs = std::collections::BTreeSet::new();
                                if let Some(info) = ep.remote_info(id).await {
                                    for addr_info in info.addrs() {
                                        addrs.insert(addr_info.addr().clone());
                                    }
                                }
                                if addrs.is_empty() {
                                    if let Some(cached) =
                                        config.cached_peer_addrs.get(&member.node_id)
                                    {
                                        for addr_str in cached {
                                            if let Ok(sock) =
                                                addr_str.parse::<std::net::SocketAddr>()
                                            {
                                                addrs.insert(
                                                    teamclaw_p2p::iroh::TransportAddr::Ip(sock),
                                                );
                                            }
                                        }
                                    }
                                }
                                if !addrs.is_empty() {
                                    other_peers
                                        .push(teamclaw_p2p::iroh::EndpointAddr { id, addrs });
                                }
                            }
                        }
                    }

                    {
                        let seed = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .subsec_nanos() as usize;
                        let len = other_peers.len();
                        for i in (1..len).rev() {
                            let j = (seed.wrapping_mul(i + 1).wrapping_add(7)) % (i + 1);
                            other_peers.swap(i, j);
                        }
                    }
                    for peer in other_peers.into_iter().take(4) {
                        if !ticket.nodes.iter().any(|n| n.id == peer.id) {
                            ticket.nodes.push(peer);
                        }
                    }

                    Some(ticket.to_string())
                }
                Err(_) => config.doc_ticket.clone(),
            }
        } else {
            config.doc_ticket.clone()
        }
    } else {
        config.doc_ticket.clone()
    };

    Ok(P2pSyncStatus {
        connected,
        role: config.role,
        doc_ticket: member_ticket,
        namespace_id: config.namespace_id,
        last_sync_at: config.last_sync_at,
        members: config.allowed_members,
        owner_node_id: config.owner_node_id,
        seed_url: config.seed_url,
        team_secret: config.team_secret,
    })
}

#[tauri::command]
pub async fn p2p_get_files_sync_status(
    iroh_state: tauri::State<'_, crate::commands::p2p_state::IrohState>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<Vec<crate::commands::oss_types::FileSyncStatus>, String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let team_dir = format!("{}/{}", workspace_path, team_repo_dir());

    let guard = iroh_state.lock().await;
    let node = guard
        .as_ref()
        .ok_or_else(|| "P2P node not running".to_string())?;

    get_files_sync_status(node, &team_dir).await
}

#[tauri::command]
pub async fn p2p_save_seed_config(
    seed_url: Option<String>,
    team_secret: Option<String>,
    opencode_state: tauri::State<'_, crate::commands::opencode::OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut config =
        read_p2p_config(&workspace_path, teamclaw_dir(), config_file_name())?.unwrap_or_default();
    if let Some(url) = seed_url {
        config.seed_url = if url.is_empty() { None } else { Some(url) };
    }
    if let Some(secret) = team_secret {
        config.team_secret = if secret.is_empty() {
            None
        } else {
            Some(secret)
        };
    }
    write_p2p_config(
        &workspace_path,
        Some(&config),
        teamclaw_dir(),
        config_file_name(),
    )?;
    Ok(())
}

#[tauri::command]
pub async fn p2p_skills_leaderboard(
    iroh_state: tauri::State<'_, IrohState>,
) -> Result<Vec<SkillsContribution>, String> {
    let guard = iroh_state.lock().await;
    let node = guard.as_ref().ok_or("P2P node not running")?;
    query_skills_leaderboard(node).await
}

#[cfg(test)]
mod tests {
    use super::ensure_p2p_node_started;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn ensure_p2p_node_started_initializes_missing_node() {
        let mut slot = None;
        let calls = Arc::new(AtomicUsize::new(0));

        {
            let calls = calls.clone();
            let value =
                ensure_p2p_node_started(&mut slot, "joining a team drive", move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, String>(41usize)
                })
                .await
                .expect("helper should initialize the slot");

            assert_eq!(*value, 41);
        }

        assert_eq!(slot, Some(41));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ensure_p2p_node_started_reuses_existing_node() {
        let mut slot = Some(7usize);
        let calls = Arc::new(AtomicUsize::new(0));

        {
            let calls = calls.clone();
            let value =
                ensure_p2p_node_started(&mut slot, "reconnecting to a team", move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, String>(99usize)
                })
                .await
                .expect("helper should return the existing slot");

            assert_eq!(*value, 7);
        }

        assert_eq!(slot, Some(7));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn ensure_p2p_node_started_wraps_start_errors_with_context() {
        let mut slot = None::<usize>;

        let err = ensure_p2p_node_started(&mut slot, "publishing the team drive", || async {
            Err::<usize, _>("boom".to_string())
        })
        .await
        .expect_err("helper should surface startup failures");

        assert_eq!(
            err,
            "Failed to start P2P node for publishing the team drive: boom"
        );
        assert_eq!(slot, None);
    }
}
