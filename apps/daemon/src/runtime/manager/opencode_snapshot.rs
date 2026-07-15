//! OpenCode `opencode.json` snapshot/restore, extracted from `manager.rs`.
//!
//! When a runtime spawns on a worktree, the daemon rewrites that worktree's
//! `opencode.json` to inject MCP-resolve config; the pre-spawn contents are
//! snapshotted here, ref-counted per worktree, and restored once the last
//! runtime on the worktree stops. Isolates the `mcp_resolve` / `refresh_watch`
//! dependency surface from the core manager.
//!
//! Child module of `runtime::manager`, so the `impl RuntimeManager` block
//! reaches the manager's private `opencode_snapshots` / `refresh_coordinator`
//! fields directly.

use std::collections::HashMap;
use std::path::Path;

use tracing::warn;

use crate::runtime::refresh::{self, refresh_watch};

use super::RuntimeManager;

/// Snapshot of a worktree's `opencode.json` before the daemon rewrote it,
/// kept until the last runtime on that worktree stops.
pub(crate) struct WorktreeOpencodeSnapshot {
    pub(super) original: String,
    pub(super) secrets: HashMap<String, String>,
    pub(super) ref_count: u32,
}

impl RuntimeManager {
    pub(super) fn register_opencode_snapshot(
        &mut self,
        worktree: &str,
        original: Option<String>,
        secrets: &HashMap<String, String>,
    ) {
        let Some(original) = original else {
            return;
        };
        let entry = self
            .opencode_snapshots
            .entry(worktree.to_string())
            .or_insert_with(|| WorktreeOpencodeSnapshot {
                original: original.clone(),
                secrets: secrets.clone(),
                ref_count: 0,
            });
        entry.original = original;
        entry.secrets = secrets.clone();
        entry.ref_count = entry.ref_count.saturating_add(1);
    }

    pub(super) fn release_opencode_snapshot(&mut self, worktree: &str) {
        let Some(entry) = self.opencode_snapshots.get_mut(worktree) else {
            return;
        };
        entry.ref_count = entry.ref_count.saturating_sub(1);
        if entry.ref_count > 0 {
            return;
        }
        let snapshot = self
            .opencode_snapshots
            .remove(worktree)
            .expect("entry exists");
        if let Some(ref refresh) = self.refresh_coordinator {
            refresh_watch::suppress_for_workspace_path(
                refresh,
                Path::new(worktree),
                &refresh::INTERNAL_OPENCODE_KINDS,
                refresh::INTERNAL_WRITE_SUPPRESS,
            );
        }
        if let Err(err) = teamclaw_runtime_env::mcp_resolve::restore_config(
            Path::new(worktree),
            &Some(snapshot.original),
            &snapshot.secrets,
        ) {
            warn!(
                worktree,
                error = %err,
                "failed to restore opencode.json after runtime stop"
            );
        }
    }
}
