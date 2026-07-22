//! Per-worktree `pi --mode rpc` process pool.
//!
//! One child per canonical worktree path (pi is single-active-session per
//! process). Sessions persist under `~/.amuxd/pi-sessions/<worktree-hash>/`
//! via `--session-dir`. Crash recovery is lazy: a dead child is respawned on
//! the next `ensure()` (attach / prompt).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{info, warn};

use super::client::PiClient;
use super::{events, Shared};

/// A live pi RPC child for one worktree.
pub(crate) struct PiProcess {
    pub(crate) client: PiClient,
    /// The acp session id currently active in this process (pi is
    /// one-active-session; prompts for another session switch first).
    pub(crate) active_acp_session: parking_lot::Mutex<Option<String>>,
    child: parking_lot::Mutex<tokio::process::Child>,
}

impl PiProcess {
    pub(crate) fn is_alive(&self) -> bool {
        matches!(self.child.lock().try_wait(), Ok(None))
    }

    pub(crate) fn kill(&self) {
        let _ = self.child.lock().start_kill();
    }
}

/// Pool of pi RPC children keyed by canonical worktree path.
pub(crate) struct PiProcessPool {
    procs: parking_lot::Mutex<HashMap<String, Arc<PiProcess>>>,
    /// `[agents.pi].binary` override from daemon config, when configured.
    binary_override: parking_lot::Mutex<Option<String>>,
    /// Extra env captured from prewarm/attach; applied on (re)spawn.
    extra_env: parking_lot::Mutex<HashMap<String, String>>,
    force_env_override: parking_lot::Mutex<bool>,
}

impl PiProcessPool {
    pub(crate) fn new() -> Self {
        Self {
            procs: parking_lot::Mutex::new(HashMap::new()),
            binary_override: parking_lot::Mutex::new(None),
            extra_env: parking_lot::Mutex::new(HashMap::new()),
            force_env_override: parking_lot::Mutex::new(false),
        }
    }

    /// Record the configured pi binary (from `AgentLaunchConfig`). The serde
    /// default `"claude"` and the plain names count as unconfigured.
    pub(crate) fn set_binary_hint(&self, binary: &str) {
        if !binary.is_empty() && binary != "claude" && binary != "pi" && binary != "opencode" {
            *self.binary_override.lock() = Some(binary.to_string());
        }
    }

    /// Merge session env into the env applied at (re)spawn (first-wins per key).
    pub(crate) fn merge_extra_env(&self, extra_env: &HashMap<String, String>, force: bool) {
        if force {
            *self.force_env_override.lock() = true;
        }
        if extra_env.is_empty() {
            return;
        }
        let mut env = self.extra_env.lock();
        for (k, v) in extra_env {
            env.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }

    pub(crate) fn get(&self, worktree: &str) -> Option<Arc<PiProcess>> {
        let mut procs = self.procs.lock();
        match procs.get(worktree) {
            Some(p) if p.is_alive() => Some(Arc::clone(p)),
            Some(_) => {
                procs.remove(worktree);
                None
            }
            None => None,
        }
    }

    /// Number of live children.
    pub(crate) fn live_count(&self) -> usize {
        self.procs.lock().values().filter(|p| p.is_alive()).count()
    }

    /// Any live child (used for the model catalog fallback).
    pub(crate) fn any_live(&self) -> Option<Arc<PiProcess>> {
        self.procs
            .lock()
            .values()
            .find(|p| p.is_alive())
            .map(Arc::clone)
    }

    /// Kill and drop all children. Returns the number that were alive.
    pub(crate) fn kill_all(&self) -> usize {
        let procs: Vec<Arc<PiProcess>> = self.procs.lock().drain().map(|(_, p)| p).collect();
        let mut killed = 0;
        for p in procs {
            if p.is_alive() {
                p.kill();
                killed += 1;
            }
        }
        killed
    }

    /// Ensure a live child for `worktree` (canonical), spawning if needed.
    pub(crate) fn ensure(
        &self,
        shared: &Arc<Shared>,
        worktree: &str,
    ) -> crate::error::Result<Arc<PiProcess>> {
        if let Some(p) = self.get(worktree) {
            return Ok(p);
        }
        let proc = self.spawn(shared, worktree)?;
        self.procs
            .lock()
            .insert(worktree.to_string(), Arc::clone(&proc));
        Ok(proc)
    }

    fn spawn(&self, shared: &Arc<Shared>, worktree: &str) -> crate::error::Result<Arc<PiProcess>> {
        let configured = self.binary_override.lock().clone();
        let binary = resolve_binary(configured.as_deref());
        let session_dir = session_dir_for(worktree);
        if let Err(e) = std::fs::create_dir_all(&session_dir) {
            warn!(dir = %session_dir.display(), error = %e, "pi session dir create failed");
        }

        let mut cmd = tokio::process::Command::new(&binary);
        cmd.arg("--mode")
            .arg("rpc")
            .arg("--session-dir")
            .arg(&session_dir)
            .current_dir(worktree);
        cmd.env(
            "PATH",
            crate::runtime::opencode_http::enriched_spawn_path(
                std::env::var("PATH").ok().as_deref(),
                dirs::home_dir().as_deref(),
            ),
        );
        let force = *self.force_env_override.lock();
        for (k, v) in self.extra_env.lock().iter() {
            if force || std::env::var_os(k).is_none() {
                cmd.env(k, v);
            }
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        info!(binary = %binary, worktree, session_dir = %session_dir.display(), "spawning pi rpc");
        let mut child = cmd.spawn().map_err(|e| {
            let hint = if e.kind() == std::io::ErrorKind::NotFound {
                "pi binary not found; install pi or switch agents.local_agent to opencode"
                    .to_string()
            } else {
                format!("spawn pi ({binary}): {e}")
            };
            crate::error::AmuxError::Agent(hint)
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| crate::error::AmuxError::Agent("pi stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| crate::error::AmuxError::Agent("pi stdout unavailable".into()))?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    warn!(target: "pi_rpc", "{line}");
                }
            });
        }

        let client = PiClient::new(stdin);
        let proc = Arc::new(PiProcess {
            client: client.clone(),
            active_acp_session: parking_lot::Mutex::new(None),
            child: parking_lot::Mutex::new(child),
        });
        events::spawn_reader(Arc::clone(shared), worktree.to_string(), stdout, client);
        Ok(proc)
    }
}

/// Resolve the pi binary amuxd should run. Order: explicit daemon config
/// override → `~/.pi/bin/pi` when present → `pi` on PATH.
pub(crate) fn resolve_binary(configured: Option<&str>) -> String {
    resolve_binary_with(configured, default_bin())
}

fn default_bin() -> Option<PathBuf> {
    let name = if cfg!(windows) { "pi.exe" } else { "pi" };
    dirs::home_dir().map(|h| h.join(".pi").join("bin").join(name))
}

fn resolve_binary_with(configured: Option<&str>, default_bin: Option<PathBuf>) -> String {
    if let Some(b) = configured {
        if !b.is_empty() && b != "claude" {
            return b.to_string();
        }
    }
    if let Some(p) = default_bin {
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "pi".to_string()
}

/// Stable (FNV-1a) hash of the canonical worktree path, used to name the
/// per-worktree session directory. Must stay stable across daemon restarts —
/// session resume depends on it — so no `DefaultHasher`.
pub(crate) fn worktree_hash(worktree: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in worktree.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

pub(crate) fn session_dir_for(worktree: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".amuxd")
        .join("pi-sessions")
        .join(worktree_hash(worktree))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_binary_precedence() {
        assert_eq!(resolve_binary_with(Some("/opt/pi"), None), "/opt/pi");
        // serde default "claude" counts as unconfigured
        assert_eq!(resolve_binary_with(Some("claude"), None), "pi");
        assert_eq!(resolve_binary_with(Some(""), None), "pi");
        assert_eq!(resolve_binary_with(None, None), "pi");
        // existing default bin wins over PATH fallback
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("pi");
        std::fs::write(&bin, "").unwrap();
        assert_eq!(
            resolve_binary_with(None, Some(bin.clone())),
            bin.to_string_lossy()
        );
    }

    #[test]
    fn worktree_hash_is_stable_and_distinct() {
        assert_eq!(worktree_hash("/a/b"), worktree_hash("/a/b"));
        assert_ne!(worktree_hash("/a/b"), worktree_hash("/a/c"));
        assert_eq!(worktree_hash("/a/b").len(), 16);
    }
}
