//! OSS (FC-mediated, AES-256-GCM) team sync engine, moved from the desktop.
pub mod conflict;
pub mod crypto;
pub mod engine;
pub mod error;
pub mod fc_client;
pub mod manifest;
pub mod path_validator;
pub mod scanner;
pub mod state;

pub use engine::tick;

use serde::{Deserialize, Serialize};

/// Conflict resolution choices (ported from desktop `oss_sync::ConflictChoice`,
/// minus the Tauri coupling).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    /// Keep the remote version (discard local edits).
    KeepRemote,
    /// Keep the local version (will be uploaded on next push).
    KeepLocal,
}
