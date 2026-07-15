//! Team-share sync engines (git + OSS) owned entirely by the daemon.
//!
//! The desktop no longer syncs; it triggers sync over HTTP and renders status.
//! See docs/superpowers/specs/2026-06-02-daemon-owns-team-sync-design.md.

// Submodules are added by later tasks; uncomment as each lands:
pub mod app_build;
pub mod app_seed;
pub mod dispatch;
pub mod git;
pub mod oss;
pub mod secret_store;
pub mod timer;
pub mod versions;
