//! teamclaw-sync: OSS/S3 sync engine and WebDAV sync for TeamClaw.
//!
//! This crate contains:
//! - Shared types for team sync (MemberRole, TeamManifest, etc.)
//! - OssSyncManager: CRDT-based S3 sync engine
//! - WebDAV sync logic (PROPFIND parser, diff, download, crypto)
//! - Version history types
//!
//! Tauri command wrappers remain in the main crate.

pub mod oss_types;
pub mod oss_sync;
pub mod team_webdav;
pub mod version_types;

// Re-export key types at crate root for convenience
pub use oss_types::*;
pub use version_types::{FileVersion, VersionedFileInfo, MAX_VERSIONS};
