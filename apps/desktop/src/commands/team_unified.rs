// apps/desktop/src/commands/team_unified.rs

use serde::{Deserialize, Serialize};

pub use super::team_types::{MemberRole, TeamManifest, TeamMember};

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
