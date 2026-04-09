use serde::{Deserialize, Serialize};

/// A single historical version of a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub index: u32,
    pub content: String,
    pub hash: String,
    pub updated_by: String,
    pub updated_at: String,
    pub deleted: bool,
}

/// Summary info for a file that has version history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedFileInfo {
    pub path: String,
    pub doc_type: String,
    pub current_deleted: bool,
    pub version_count: u32,
    pub latest_update_at: String,
    pub latest_update_by: String,
}

/// Max number of versions to keep per file.
pub const MAX_VERSIONS: usize = 20;
