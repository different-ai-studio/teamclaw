use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Shared team types (canonical definitions — main crate re-exports these)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum MemberRole {
    Owner,
    Manager,
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

// ---------------------------------------------------------------------------
// OSS sync types
// ---------------------------------------------------------------------------

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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SyncHealth {
    #[default]
    Healthy,
    Warning,
    Error,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub connected: bool,
    pub syncing: bool,
    pub last_data_sync_at: Option<String>,
    pub last_check_at: Option<String>,
    pub next_sync_at: Option<String>,
    pub health: SyncHealth,
    pub health_message: Option<String>,
    pub skipped_files: Vec<SkippedFile>,
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
    #[serde(alias = "fcEndpoint")]
    pub team_endpoint: String,
    #[serde(default)]
    pub force_path_style: bool,
    pub last_sync_at: Option<String>,
    pub poll_interval_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApplication {
    pub team_id: String,
    pub team_endpoint: String,
    pub applied_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DocType {
    Skills,
    Mcp,
    Knowledge,
    Meta,
    Secrets,
}

impl DocType {
    pub fn path(&self) -> &str {
        match self {
            DocType::Skills => "skills",
            DocType::Mcp => "mcp",
            DocType::Knowledge => "knowledge",
            DocType::Meta => "meta",
            DocType::Secrets => "secrets",
        }
    }

    pub fn dir_name(&self) -> &str {
        match self {
            DocType::Skills => "skills",
            DocType::Mcp => ".mcp",
            DocType::Knowledge => "knowledge",
            DocType::Meta => "_meta",
            DocType::Secrets => "_secrets",
        }
    }

    pub fn from_path(s: &str) -> Option<DocType> {
        match s {
            "skills" => Some(DocType::Skills),
            "mcp" => Some(DocType::Mcp),
            "knowledge" => Some(DocType::Knowledge),
            "meta" => Some(DocType::Meta),
            "secrets" => Some(DocType::Secrets),
            _ => None,
        }
    }

    pub fn all() -> [DocType; 5] {
        [
            DocType::Skills,
            DocType::Mcp,
            DocType::Knowledge,
            DocType::Meta,
            DocType::Secrets,
        ]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncFileStatus {
    Synced,
    Modified,
    New,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSyncStatus {
    pub path: String,
    pub doc_type: String,
    pub status: SyncFileStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncCursor {
    /// Last processed update key per DocType (for start_after pruning)
    #[serde(default)]
    pub last_known_keys: HashMap<String, String>,
    /// Per-node cursors: key = "docType:nodePrefix", value = last processed S3 key.
    #[serde(default)]
    pub last_known_keys_per_node: HashMap<String, String>,
    /// Signal flag keys already processed
    #[serde(default)]
    pub known_signal_keys: Vec<String>,
    /// Last compaction timestamp per DocType (RFC3339)
    #[serde(default)]
    pub last_compaction_at: HashMap<String, String>,
    /// Loro version vector bytes per DocType, base64-encoded
    #[serde(default)]
    pub last_exported_version: HashMap<String, String>,
    /// Last local file mtime scan time per DocType, unix timestamp millis
    #[serde(default)]
    pub last_scan_time: HashMap<String, u64>,
    /// Known local files per DocType, for deletion detection across restarts
    #[serde(default)]
    pub known_files: HashMap<String, Vec<String>>,
    /// Current generation ID per DocType (updated after each compaction)
    #[serde(default)]
    pub generation: HashMap<String, String>,
}
