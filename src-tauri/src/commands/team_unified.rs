// src-tauri/src/commands/team_unified.rs

use serde::{Deserialize, Serialize};
use tauri::State;

// --- Shared Types ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum MemberRole {
    Owner,
    #[default]
    #[serde(alias = "member")]
    Editor,
    Viewer,
    /// Always-on replication node, not a human member
    Seed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub node_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: MemberRole,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamManifest {
    pub owner_node_id: String,
    pub members: Vec<TeamMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct TeamCreateResult {
    pub team_id: Option<String>,
    pub ticket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct TeamJoinResult {
    pub success: bool,
    pub role: MemberRole,
    pub members: Vec<TeamMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "message")]
#[allow(dead_code)]
pub enum TeamJoinError {
    InvalidTicket(String),
    DeviceNotRegistered(String),
    AlreadyInTeam(String),
    SyncError(String),
}

impl std::fmt::Display for TeamJoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidTicket(msg) => write!(f, "{}", msg),
            Self::DeviceNotRegistered(msg) => write!(f, "{}", msg),
            Self::AlreadyInTeam(msg) => write!(f, "{}", msg),
            Self::SyncError(msg) => write!(f, "{}", msg),
        }
    }
}

// --- Validation Helpers ---

/// Validate NodeId format: non-empty hex string
pub fn validate_node_id(node_id: &str) -> Result<(), String> {
    if node_id.is_empty() {
        return Err("NodeId cannot be empty".to_string());
    }
    if !node_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("NodeId must be a valid hex string".to_string());
    }
    Ok(())
}

// --- Unified Tauri Commands ---

/// Get the list of team members from the active sync mode.
/// - P2P: reads from p2p config's allowed_members
#[tauri::command]
pub async fn unified_team_get_members(
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    iroh_state: State<'_, super::p2p_state::IrohState>,
) -> Result<Vec<TeamMember>, String> {
    let workspace_path = super::team::get_workspace_path(&opencode_state)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        #[cfg(feature = "p2p")]
        Some("p2p") => {
            let _ = iroh_state;
            let config = super::team_p2p::read_p2p_config(&workspace_path)?.unwrap_or_default();
            Ok(config.allowed_members)
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Add a member to the active team.
/// Validates NodeId format, checks caller role, then adds member.
#[tauri::command]
pub async fn unified_team_add_member(
    member: TeamMember,
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    iroh_state: State<'_, super::p2p_state::IrohState>,
) -> Result<(), String> {
    validate_node_id(&member.node_id)?;

    let workspace_path = super::team::get_workspace_path(&opencode_state)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        #[cfg(feature = "p2p")]
        Some("p2p") => {
            let mut guard = iroh_state.lock().await;
            let node = guard.as_mut().ok_or("P2P node not running")?;
            let caller_node_id = super::team_p2p::get_node_id(node);
            let team_dir = format!("{}/teamclaw-team", workspace_path);
            super::team_p2p::add_member_to_team(
                &workspace_path,
                &team_dir,
                &caller_node_id,
                member,
            )?;
            // Push updated members.json to Iroh doc immediately (don't rely on fs watcher)
            if let Some(ref doc) = node.active_doc {
                let manifest_path = format!("{}/{}", team_dir, "_team/members.json");
                if let Ok(content) = std::fs::read(&manifest_path) {
                    let _ = doc
                        .set_bytes(node.author, "_team/members.json", content)
                        .await;
                }
            }
            drop(guard);
            Ok(())
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Remove a member from the active team.
/// Checks caller role before removing.
#[tauri::command]
pub async fn unified_team_remove_member(
    node_id: String,
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    iroh_state: State<'_, super::p2p_state::IrohState>,
) -> Result<(), String> {
    let workspace_path = super::team::get_workspace_path(&opencode_state)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        #[cfg(feature = "p2p")]
        Some("p2p") => {
            let mut guard = iroh_state.lock().await;
            let node = guard.as_mut().ok_or("P2P node not running")?;
            let caller_node_id = super::team_p2p::get_node_id(node);
            let team_dir = format!("{}/teamclaw-team", workspace_path);
            super::team_p2p::remove_member_from_team(
                &workspace_path,
                &team_dir,
                &caller_node_id,
                &node_id,
            )?;
            // Push updated members.json to Iroh doc immediately
            if let Some(ref doc) = node.active_doc {
                let manifest_path = format!("{}/{}", team_dir, "_team/members.json");
                if let Ok(content) = std::fs::read(&manifest_path) {
                    let _ = doc
                        .set_bytes(node.author, "_team/members.json", content)
                        .await;
                }
            }
            drop(guard);
            Ok(())
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Update a team member's role.
/// Checks caller role before updating.
#[tauri::command]
pub async fn unified_team_update_member_role(
    node_id: String,
    role: MemberRole,
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    iroh_state: State<'_, super::p2p_state::IrohState>,
) -> Result<(), String> {
    let workspace_path = super::team::get_workspace_path(&opencode_state)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        #[cfg(feature = "p2p")]
        Some("p2p") => {
            let guard = iroh_state.lock().await;
            let node = guard.as_ref().ok_or("P2P node not running")?;
            let caller_node_id = super::team_p2p::get_node_id(node);
            drop(guard);
            let team_dir = format!("{}/teamclaw-team", workspace_path);
            super::team_p2p::update_member_role(
                &workspace_path,
                &team_dir,
                &caller_node_id,
                &node_id,
                role,
            )
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Get the current device's role in the active team.
#[tauri::command]
pub async fn unified_team_get_my_role(
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    iroh_state: State<'_, super::p2p_state::IrohState>,
) -> Result<MemberRole, String> {
    let workspace_path = super::team::get_workspace_path(&opencode_state)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        #[cfg(feature = "p2p")]
        Some("p2p") => {
            let _ = iroh_state;
            let config =
                super::team_p2p::read_p2p_config(&workspace_path)?.ok_or("No P2P config found")?;
            config
                .role
                .ok_or_else(|| "Role not set in P2P config".to_string())
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}
