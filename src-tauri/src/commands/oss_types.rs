use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub use super::team_unified::{MemberRole, TeamManifest, TeamMember};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OssCredentials {
    pub access_key_id: String,
    pub access_key_secret: String,
    pub security_token: String,
    pub expiration: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OssConfig {
    pub bucket: String,
    pub region: String,
    pub endpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FcResponse {
    pub credentials: OssCredentials,
    pub oss: OssConfig,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OssTeamInfo {
    pub team_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_secret: Option<String>,
    pub team_name: String,
    pub owner_name: String,
    pub role: MemberRole,
}

// Note on serde attributes:
// - `tag = "status"` puts the variant name as "status" field
// - `rename_all = "camelCase"` applies to field names (node_id -> nodeId, team_name -> teamName)
// - Explicit `#[serde(rename = "...")]` on variants overrides `rename_all` for the tag value
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum OssJoinResult {
    #[serde(rename = "joined")]
    Joined {
        #[serde(flatten)]
        info: OssTeamInfo,
    },
    #[serde(rename = "not_member")]
    NotMember { node_id: String, team_name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamApplication {
    pub node_id: String,
    pub name: String,
    pub email: String,
    pub note: String,
    pub platform: String,
    pub arch: String,
    pub hostname: String,
    pub applied_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub connected: bool,
    pub syncing: bool,
    pub last_sync_at: Option<String>,
    pub next_sync_at: Option<String>,
    pub docs: HashMap<String, DocSyncStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSyncStatus {
    pub local_version: u64,
    pub remote_update_count: u32,
    pub last_upload_at: Option<String>,
    pub last_download_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub deleted_count: u32,
    pub freed_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OssTeamConfig {
    pub enabled: bool,
    pub team_id: String,
    pub fc_endpoint: String,
    pub last_sync_at: Option<String>,
    pub poll_interval_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApplication {
    pub team_id: String,
    pub fc_endpoint: String,
    pub applied_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DocType {
    Skills,
    Mcp,
    Knowledge,
}

impl DocType {
    pub fn path(&self) -> &str {
        match self {
            DocType::Skills => "skills",
            DocType::Mcp => "mcp",
            DocType::Knowledge => "knowledge",
        }
    }

    pub fn dir_name(&self) -> &str {
        match self {
            DocType::Skills => "skills",
            DocType::Mcp => ".mcp",
            DocType::Knowledge => "knowledge",
        }
    }

    pub fn all() -> [DocType; 3] {
        [DocType::Skills, DocType::Mcp, DocType::Knowledge]
    }
}
