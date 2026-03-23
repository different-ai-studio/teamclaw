// src-tauri/src/commands/team_unified.rs

use serde::{Deserialize, Serialize};

// --- Shared Types ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum MemberRole {
    Owner,
    #[default]
    Editor,
    Viewer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamMember {
    pub node_id: String,
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
pub struct TeamManifest {
    pub owner_node_id: String,
    pub members: Vec<TeamMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamCreateResult {
    pub team_id: Option<String>,
    pub ticket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamJoinResult {
    pub success: bool,
    pub role: MemberRole,
    pub members: Vec<TeamMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "message")]
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

/// Check if a role can manage members (add/remove/edit)
pub fn can_manage_members(role: &MemberRole) -> bool {
    matches!(role, MemberRole::Owner | MemberRole::Editor)
}

/// Find a member's role in a manifest by node_id
pub fn find_member_role(manifest: &TeamManifest, node_id: &str) -> Option<MemberRole> {
    manifest
        .members
        .iter()
        .find(|m| m.node_id == node_id)
        .map(|m| m.role.clone())
}
