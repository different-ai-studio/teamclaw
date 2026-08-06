//! Mirrors the team config that now lives in the Cloud API (team MCP, team env)
//! onto a daemon-owned cache directory, so the synchronous readers can keep
//! reading files.
//!
//! Design: docs/architecture/team-mcp-and-env-cloud.md
//!
//! # Why a file cache instead of fetching at the call site
//!
//! [`crate::config::team_mcp::scan_team_mcp`] and
//! [`crate::team_shared_env::load_team_env_for_workspace_detailed`] are both
//! **synchronous**, and both are reached from synchronous call sites — most
//! importantly `assemble_spawn_runtime_env`, on the runtime spawn path. There is
//! no way to inline an `await` into them without either blocking a Tokio worker
//! or restructuring every caller.
//!
//! More fundamentally, agents have to run offline. A cloud round-trip on the
//! spawn path would make "the network is down" mean "your agent starts with no
//! team env", which silently produces literal `${KEY}` strings in MCP configs
//! (`resolve_config_secret_refs` short-circuits on an empty secret map) and a
//! runtime that fails with opaque 401s.
//!
//! So the fetch is a background reconcile and the readers stay on the
//! filesystem. The cache is the contract between them.
//!
//! # The cache never shrinks on failure
//!
//! A fetch error leaves the previous cache **exactly as it was**. This is the
//! whole offline story, and it also closes a subtler trap: if the team MCP map
//! were allowed to go empty while entries were still materialized into a
//! workspace's `opencode.json`, `classify_source` would reclassify every one of
//! them as `Workspace`, the UI would offer them for editing, and
//! `filter_put_body` would persist them as workspace-owned — a permanent local
//! fork that survives the network coming back. Keeping stale-but-correct data
//! is strictly better than briefly correct-looking emptiness.
//!
//! Note the in-memory TTL cache used by [`crate::runtime::managed_llm`] is not
//! sufficient here: it is process-local and empty after every daemon restart.
//! That is survivable for managed LLM because its durable artifact is
//! `opencode.json` on disk; team env has no such artifact — it is decrypted and
//! injected fresh on every spawn.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

use crate::backend::Backend;
use crate::config::global_team_store::global_team_cloud_dir;

/// How long a successful fetch is trusted before another is attempted.
/// Matches `managed_llm`'s TTL — these are the same class of team-scoped config
/// and there is no reason for them to converge at different rates.
const TEAM_CLOUD_TTL: Duration = Duration::from_secs(60);

/// Name of the single team-MCP cache file. One file rather than one per server
/// so a fetch lands atomically: a partial rename sequence must never be able to
/// present half a team's servers as the whole set.
const MCP_CACHE_FILE: &str = "team.json";

pub struct TeamCloudConfigResolver {
    backend: Arc<dyn Backend>,
    last_fetch: AsyncMutex<HashMap<String, Instant>>,
}

/// What a reconcile actually changed on disk, so callers can decide whether to
/// signal a runtime refresh.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TeamCloudReconcileOutcome {
    pub mcp_changed: bool,
    pub env_changed: bool,
}

impl TeamCloudReconcileOutcome {
    pub fn changed(self) -> bool {
        self.mcp_changed || self.env_changed
    }
}

/// Report what a reconcile changed.
///
/// **Known gap, deliberately left for the PR that makes it reachable.** When the
/// cache changes, affected workspaces should also get a
/// `RefreshChangeKind::{Mcp, EnvVars}` recorded so the UI surfaces "runtime
/// needs restart" — that is what `refresh_watch` does today for the on-disk
/// `.mcp/` and `_secrets/` directories, and the cloud cache is outside every
/// watched root (it is a daemon-private sibling of the synced team dir, by
/// design). The signal cannot ride the watcher; it has to come from here.
///
/// It is not wired yet because `RefreshCoordinator::record_change` is
/// per-workspace while this resolver is per-team, so it needs a fan-out over the
/// team's workspaces — and until clients start writing team MCP/env, every
/// reconcile is a no-op, which would make that fan-out untestable dead code.
/// Wire it alongside the first write path.
pub fn log_team_cloud_outcome(team_id: &str, outcome: TeamCloudReconcileOutcome) {
    if outcome.changed() {
        tracing::info!(
            team_id,
            mcp_changed = outcome.mcp_changed,
            env_changed = outcome.env_changed,
            "team cloud config cache updated"
        );
    }
}

pub fn team_cloud_mcp_dir(team_id: &str) -> PathBuf {
    global_team_cloud_dir(team_id).join(".mcp")
}

pub fn team_cloud_secrets_dir(team_id: &str) -> PathBuf {
    global_team_cloud_dir(team_id).join("_secrets")
}

/// Write `contents` to `path` atomically, returning whether the bytes changed.
///
/// tmp+rename rather than truncate+write because the readers are not
/// coordinated with this writer: a reader that opens the file mid-write must see
/// either the old contents or the new ones, never a truncated prefix that fails
/// to parse and silently drops a team's whole MCP set.
fn write_if_changed(path: &Path, contents: &str) -> std::io::Result<bool> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == contents {
            return Ok(false);
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(true)
}

impl TeamCloudConfigResolver {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            last_fetch: AsyncMutex::new(HashMap::new()),
        }
    }

    /// Refresh the cache if the TTL has expired. Safe to call on any hot path —
    /// at most one request per team per [`TEAM_CLOUD_TTL`].
    pub async fn reconcile(&self, team_id: &str) -> TeamCloudReconcileOutcome {
        if let Some(fetched_at) = self.last_fetch.lock().await.get(team_id) {
            if fetched_at.elapsed() < TEAM_CLOUD_TTL {
                return TeamCloudReconcileOutcome::default();
            }
        }
        self.reconcile_now(team_id).await
    }

    /// Refresh regardless of TTL. Used right after a local write, where waiting
    /// out the TTL would show the user their own change not taking effect.
    pub async fn reconcile_now(&self, team_id: &str) -> TeamCloudReconcileOutcome {
        let mcp_changed = self.reconcile_mcp(team_id).await;
        let env_changed = self.reconcile_env(team_id).await;

        // Only mark the team fetched when *both* halves succeeded. A partial
        // success left as "fetched" would sit stale for a full TTL.
        if mcp_changed.is_some() && env_changed.is_some() {
            self.last_fetch
                .lock()
                .await
                .insert(team_id.to_string(), Instant::now());
        }

        TeamCloudReconcileOutcome {
            mcp_changed: mcp_changed.unwrap_or(false),
            env_changed: env_changed.unwrap_or(false),
        }
    }

    /// `None` on fetch/write failure (cache left untouched), `Some(changed)` otherwise.
    async fn reconcile_mcp(&self, team_id: &str) -> Option<bool> {
        let config = match self.backend.team_mcp_config(team_id).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    team_id,
                    error = %e,
                    "team MCP cloud fetch failed; keeping the existing cache"
                );
                return None;
            }
        };

        // Serialize with the same shape the reader expects (`{"mcpServers": {…}}`).
        // A response missing the key at all is treated as a fetch problem rather
        // than as "the team has no servers" — the latter would be an unforced
        // way to wipe a working cache over a server-side shape change.
        if config.get("mcpServers").is_none() {
            tracing::warn!(
                team_id,
                "team MCP response had no mcpServers key; keeping the existing cache"
            );
            return None;
        }

        let path = team_cloud_mcp_dir(team_id).join(MCP_CACHE_FILE);
        let body = match serde_json::to_string_pretty(&config) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(team_id, error = %e, "failed to serialize team MCP cache");
                return None;
            }
        };
        match write_if_changed(&path, &body) {
            Ok(changed) => Some(changed),
            Err(e) => {
                tracing::warn!(team_id, error = %e, "failed to write team MCP cache");
                None
            }
        }
    }

    /// `None` on fetch failure (cache left untouched), `Some(changed)` otherwise.
    async fn reconcile_env(&self, team_id: &str) -> Option<bool> {
        let rows = match self.backend.team_env_secrets(team_id).await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(
                    team_id,
                    error = %e,
                    "team env cloud fetch failed; keeping the existing cache"
                );
                return None;
            }
        };

        let dir = team_cloud_secrets_dir(team_id);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(team_id, error = %e, "failed to create team env cache dir");
            return None;
        }

        let mut changed = false;
        let mut written = std::collections::HashSet::new();
        for row in &rows {
            // The key id lands in a filename, so anything that could escape the
            // directory is dropped rather than sanitised — a surprising rename is
            // worse than a missing key, and the server enforces the same charset.
            if row.key_id.is_empty()
                || !row
                    .key_id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            {
                tracing::warn!(team_id, key_id = %row.key_id, "skipping team env key with an unexpected id");
                continue;
            }
            let path = dir.join(format!("{}.enc.json", row.key_id));
            let body = match serde_json::to_string_pretty(&row.envelope) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(team_id, key_id = %row.key_id, error = %e, "failed to serialize team env envelope");
                    continue;
                }
            };
            match write_if_changed(&path, &body) {
                Ok(did) => {
                    changed |= did;
                    written.insert(format!("{}.enc.json", row.key_id));
                }
                Err(e) => {
                    tracing::warn!(team_id, key_id = %row.key_id, error = %e, "failed to write team env cache file");
                }
            }
        }

        // Reconcile deletions. Scoped to this directory, which only ever holds
        // files this resolver wrote — that is exactly why the cache is a
        // daemon-owned sibling of the synced team dir and not a subdirectory of
        // it. Only runs on a successful fetch, so an outage never deletes keys.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if !name.ends_with(".enc.json") || written.contains(name) {
                    continue;
                }
                if std::fs::remove_file(entry.path()).is_ok() {
                    changed = true;
                }
            }
        }

        Some(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_if_changed_reports_no_change_for_identical_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested").join("team.json");

        assert!(write_if_changed(&path, "{\"a\":1}").unwrap());
        assert!(!write_if_changed(&path, "{\"a\":1}").unwrap());
        assert!(write_if_changed(&path, "{\"a\":2}").unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");
    }

    #[test]
    fn write_if_changed_leaves_no_tmp_file_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("team.json");
        write_if_changed(&path, "{}").unwrap();

        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "stray tmp files: {leftovers:?}");
    }
}
