use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tracing::{debug, info, warn};

use super::adapter::{self, AcpCommand, AcpStartupMetadata};
use super::manager::AgentLaunchConfig;
use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;

const HOST_INIT_TIMEOUT: Duration = Duration::from_secs(60);
// Attach covers the ACP `session/new` round-trip. On a cold host this can take
// 50–70s for ClaudeCode (CLI startup + workspace MCP/skill scan), well past the
// old 30s cap, which surfaced as `spawn runtime: ACP attach timed out before
// ready` 500s even though the session ultimately came up. Give it real headroom.
const ATTACH_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct HostKey {
    agent_type: amux::AgentType,
    env_fingerprint: u64,
    worktree_fingerprint: u64,
}

fn env_fingerprint(extra_env: &HashMap<String, String>) -> u64 {
    let mut sorted: Vec<_> = extra_env.iter().collect();
    sorted.sort_by_key(|(k, _)| *k);
    let mut hasher = DefaultHasher::new();
    for (k, v) in sorted {
        k.hash(&mut hasher);
        v.hash(&mut hasher);
    }
    hasher.finish()
}

fn worktree_fingerprint(agent_type: amux::AgentType, worktree: Option<&str>) -> u64 {
    if !matches!(
        agent_type,
        amux::AgentType::Opencode | amux::AgentType::Codex
    ) {
        return 0;
    }
    let Some(worktree) = worktree.filter(|s| !s.is_empty()) else {
        return 0;
    };
    let worktree = std::fs::canonicalize(worktree)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| worktree.to_string());
    let mut hasher = DefaultHasher::new();
    worktree.hash(&mut hasher);
    hasher.finish()
}

struct HostEntry {
    cmd_tx: mpsc::Sender<AcpCommand>,
}

/// Ask a host task to exit (which kills its child process via `kill_on_drop`).
/// Fire-and-forget: `try_send` never blocks callers holding the pool (behind
/// the RuntimeManager mutex); only a full command queue falls back to a
/// detached task.
fn shutdown_host_async(cmd_tx: mpsc::Sender<AcpCommand>, reason: &'static str) {
    match cmd_tx.try_send(AcpCommand::Shutdown) {
        Ok(()) => debug!(reason, "ACP host shutdown requested"),
        Err(mpsc::error::TrySendError::Closed(_)) => {
            // Host task already gone — nothing to clean up.
        }
        Err(mpsc::error::TrySendError::Full(_)) => {
            tokio::spawn(async move {
                let _ = cmd_tx.send(AcpCommand::Shutdown).await;
            });
        }
    }
}

/// Pool of long-lived ACP hosts — one `initialize` per host, many `session/new`.
pub struct AcpHostPool {
    hosts: HashMap<HostKey, HostEntry>,
}

impl AcpHostPool {
    pub fn new() -> Self {
        Self {
            hosts: HashMap::new(),
        }
    }

    /// Number of prewarmed hosts currently alive in the pool.
    pub fn host_count(&self) -> usize {
        self.hosts.len()
    }

    /// Drop cached ACP host processes so the next attach spawns fresh binaries.
    ///
    /// Required after provider OAuth / apiKey changes: long-lived `opencode acp`
    /// hosts only read auth state at process start.
    pub fn evict_agent_types(&mut self, agent_types: &[amux::AgentType]) -> usize {
        let before = self.hosts.len();
        self.hosts.retain(|key, entry| {
            if agent_types.contains(&key.agent_type) {
                // Removing the entry alone leaks the host: the host loop keeps
                // running on its other select arms after the command channel
                // closes, so the child process survives as a zombie. Tell it to
                // exit (child is `kill_on_drop`).
                shutdown_host_async(entry.cmd_tx.clone(), "evict_agent_types");
                false
            } else {
                true
            }
        });
        before.saturating_sub(self.hosts.len())
    }

    /// Remove pool entries that can never serve another session and shut their
    /// host processes down:
    /// - dead hosts (command channel closed — the host task exited), and
    /// - stale-env hosts: same `(agent_type, worktree)` as `fresh` but a
    ///   different `env_fingerprint`. Once a new env is materialized the old
    ///   host's fingerprint never matches an attach again; without reaping it
    ///   idles forever holding ~100MB (opencode) plus its MCP children.
    fn reap_stale_hosts(&mut self, fresh: &HostKey) {
        let mut reaped = 0usize;
        self.hosts.retain(|key, entry| {
            if key == fresh {
                return true;
            }
            if entry.cmd_tx.is_closed() {
                reaped += 1;
                return false;
            }
            let superseded = key.agent_type == fresh.agent_type
                && key.worktree_fingerprint == fresh.worktree_fingerprint
                && key.env_fingerprint != fresh.env_fingerprint;
            if superseded {
                shutdown_host_async(entry.cmd_tx.clone(), "stale env superseded");
                reaped += 1;
                return false;
            }
            true
        });
        if reaped > 0 {
            info!(
                reaped,
                agent_type = ?fresh.agent_type,
                "reaped stale/dead ACP hosts from pool"
            );
        }
    }

    /// Pre-warm one host per configured agent type (empty team env).
    ///
    /// Fallback for when no workspace env is known yet (e.g. a fresh install
    /// with no linked workspace). Prefer [`Self::prewarm_with_env`] whenever a
    /// real session env is available: an empty-env host has a different
    /// `env_fingerprint` than any team session, so it is never reused and the
    /// first real `attach_session` still pays the full cold `initialize`.
    pub async fn prewarm(&mut self, launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>) {
        for (&agent_type, launch) in launch_configs {
            if let Err(e) = self
                .ensure_host(agent_type, launch, HashMap::new(), false, None)
                .await
            {
                warn!(?agent_type, error = %e, "ACP host prewarm failed");
            } else {
                info!(?agent_type, "ACP host prewarmed");
            }
        }
    }

    /// Pre-warm one host per configured agent type using a *real* session env,
    /// so the resulting `HostKey.env_fingerprint` matches the first real
    /// `attach_session` for that env and the cold `initialize` is amortized off
    /// the critical path. The caller must have already materialized any
    /// `opencode.json` `provider.team` for this env (the host reads config at
    /// process start), so the prewarmed host advertises the right model list.
    pub async fn prewarm_with_env(
        &mut self,
        launch_configs: &HashMap<amux::AgentType, AgentLaunchConfig>,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: Option<&str>,
    ) {
        for (&agent_type, launch) in launch_configs {
            if let Err(e) = self
                .ensure_host(
                    agent_type,
                    launch,
                    extra_env.clone(),
                    force_env_override,
                    worktree,
                )
                .await
            {
                warn!(?agent_type, error = %e, "ACP host prewarm (session env) failed");
            } else {
                info!(?agent_type, "ACP host prewarmed (session env)");
            }
        }
    }

    async fn ensure_host(
        &mut self,
        agent_type: amux::AgentType,
        launch: &AgentLaunchConfig,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: Option<&str>,
    ) -> crate::error::Result<mpsc::Sender<AcpCommand>> {
        let key = HostKey {
            agent_type,
            env_fingerprint: env_fingerprint(&extra_env),
            worktree_fingerprint: worktree_fingerprint(agent_type, worktree),
        };
        if let Some(entry) = self.hosts.get(&key) {
            if entry.cmd_tx.is_closed() {
                // Host task died (process exit / fatal error) but the entry was
                // never removed. Treat as a miss and respawn below.
                warn!(
                    ?agent_type,
                    worktree = worktree.unwrap_or(""),
                    "ACP host pool hit but host is dead; respawning"
                );
                self.hosts.remove(&key);
            } else {
                debug!(
                    ?agent_type,
                    worktree = worktree.unwrap_or(""),
                    env_fingerprint = key.env_fingerprint,
                    worktree_fingerprint = key.worktree_fingerprint,
                    "ACP host pool hit; reusing initialized host"
                );
                return Ok(entry.cmd_tx.clone());
            }
        }

        info!(
            ?agent_type,
            worktree = worktree.unwrap_or(""),
            env_fingerprint = key.env_fingerprint,
            worktree_fingerprint = key.worktree_fingerprint,
            "ACP host pool miss; spawning initialized host"
        );

        let (host_ready_tx, host_ready_rx) = oneshot::channel();
        let cmd_tx = adapter::spawn_acp_host(
            launch.binary.clone(),
            launch.args.clone(),
            agent_type,
            extra_env,
            force_env_override,
            worktree.map(str::to_string),
            host_ready_tx,
        )?;

        match timeout(HOST_INIT_TIMEOUT, host_ready_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(details))) => {
                return Err(crate::error::AmuxError::Agent(format!(
                    "ACP host init failed: {details}"
                )));
            }
            Ok(Err(_)) => {
                return Err(crate::error::AmuxError::Agent(
                    "ACP host init channel closed".into(),
                ));
            }
            Err(_) => {
                return Err(crate::error::AmuxError::Agent(
                    "ACP host init timed out".into(),
                ));
            }
        }

        self.hosts.insert(
            key,
            HostEntry {
                cmd_tx: cmd_tx.clone(),
            },
        );
        // A new host for this (agent_type, worktree) supersedes any host with a
        // previous env fingerprint; reap those (and any dead entries) so the
        // pool doesn't accumulate zombie processes across env changes.
        self.reap_stale_hosts(&key);
        info!(
            ?agent_type,
            worktree = worktree.unwrap_or(""),
            env_fingerprint = key.env_fingerprint,
            worktree_fingerprint = key.worktree_fingerprint,
            "ACP host cached"
        );
        Ok(cmd_tx)
    }

    /// Bind a TeamClaw runtime to a shared host via `session/new`.
    #[allow(clippy::too_many_arguments)]
    pub async fn attach_session(
        &mut self,
        agent_type: amux::AgentType,
        launch: &AgentLaunchConfig,
        extra_env: HashMap<String, String>,
        force_env_override: bool,
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<std::path::PathBuf>,
        initial_model_override: Option<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<AcpEventFrame>,
        is_gateway: bool,
        forbid_new_session_fallback: bool,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)> {
        let host_cmd = self
            .ensure_host(
                agent_type,
                launch,
                extra_env,
                force_env_override,
                Some(&worktree),
            )
            .await?;
        let (startup_tx, startup_rx) = oneshot::channel::<Result<AcpStartupMetadata, String>>();

        host_cmd
            .send(AcpCommand::AttachSession {
                worktree,
                resume_acp_session_id,
                mcp_config_path,
                initial_model_override,
                initial_prompt,
                event_tx,
                startup_tx,
                is_gateway,
                forbid_new_session_fallback,
            })
            .await
            .map_err(|_| {
                crate::error::AmuxError::Agent("ACP host command channel closed".into())
            })?;

        let startup = match timeout(ATTACH_TIMEOUT, startup_rx).await {
            Ok(Ok(Ok(meta))) => meta,
            Ok(Ok(Err(details))) => {
                return Err(crate::error::AmuxError::Agent(format!(
                    "ACP attach failed: {details}"
                )));
            }
            Ok(Err(_)) => {
                return Err(crate::error::AmuxError::Agent(
                    "ACP attach channel closed before ready".into(),
                ));
            }
            Err(_) => {
                return Err(crate::error::AmuxError::Agent(
                    "ACP attach timed out before ready".into(),
                ));
            }
        };

        Ok((host_cmd, startup))
    }
}

impl Default for AcpHostPool {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evict_agent_types_removes_matching_hosts_only() {
        let mut pool = AcpHostPool::new();
        pool.hosts.insert(
            HostKey {
                agent_type: amux::AgentType::Opencode,
                env_fingerprint: 1,
                worktree_fingerprint: 11,
            },
            HostEntry {
                cmd_tx: mpsc::channel(1).0,
            },
        );
        pool.hosts.insert(
            HostKey {
                agent_type: amux::AgentType::ClaudeCode,
                env_fingerprint: 2,
                worktree_fingerprint: 0,
            },
            HostEntry {
                cmd_tx: mpsc::channel(1).0,
            },
        );
        let removed = pool.evict_agent_types(&[amux::AgentType::Opencode]);
        assert_eq!(removed, 1);
        assert_eq!(pool.hosts.len(), 1);
        assert_eq!(
            pool.hosts.keys().next().unwrap().agent_type,
            amux::AgentType::ClaudeCode
        );
    }

    #[test]
    fn reap_removes_superseded_env_and_dead_hosts_only() {
        let mut pool = AcpHostPool::new();
        let fresh = HostKey {
            agent_type: amux::AgentType::Opencode,
            env_fingerprint: 2,
            worktree_fingerprint: 11,
        };
        let (fresh_tx, _fresh_rx) = mpsc::channel(1);
        pool.hosts.insert(fresh, HostEntry { cmd_tx: fresh_tx });
        // Same agent+worktree, older env → superseded.
        let (old_tx, mut old_rx) = mpsc::channel(1);
        pool.hosts.insert(
            HostKey {
                env_fingerprint: 1,
                ..fresh
            },
            HostEntry { cmd_tx: old_tx },
        );
        // Same agent, different worktree → kept.
        let (other_tx, _other_rx) = mpsc::channel(1);
        pool.hosts.insert(
            HostKey {
                worktree_fingerprint: 99,
                ..fresh
            },
            HostEntry { cmd_tx: other_tx },
        );
        // Dead host (receiver dropped) on another agent type → reaped.
        let (dead_tx, dead_rx) = mpsc::channel(1);
        drop(dead_rx);
        pool.hosts.insert(
            HostKey {
                agent_type: amux::AgentType::ClaudeCode,
                env_fingerprint: 7,
                worktree_fingerprint: 0,
            },
            HostEntry { cmd_tx: dead_tx },
        );

        pool.reap_stale_hosts(&fresh);

        assert_eq!(pool.hosts.len(), 2, "fresh + different-worktree survive");
        assert!(pool.hosts.contains_key(&fresh));
        // The superseded host was asked to shut down.
        assert!(matches!(old_rx.try_recv(), Ok(AcpCommand::Shutdown)));
    }

    #[test]
    fn evict_sends_shutdown_to_evicted_hosts() {
        let mut pool = AcpHostPool::new();
        let (tx, mut rx) = mpsc::channel(1);
        pool.hosts.insert(
            HostKey {
                agent_type: amux::AgentType::Opencode,
                env_fingerprint: 1,
                worktree_fingerprint: 11,
            },
            HostEntry { cmd_tx: tx },
        );
        assert_eq!(pool.evict_agent_types(&[amux::AgentType::Opencode]), 1);
        assert!(matches!(rx.try_recv(), Ok(AcpCommand::Shutdown)));
    }

    #[test]
    fn worktree_fingerprint_is_only_used_for_shared_registry_hosts() {
        assert_ne!(
            worktree_fingerprint(amux::AgentType::Opencode, Some("/tmp/a")),
            worktree_fingerprint(amux::AgentType::Opencode, Some("/tmp/b"))
        );
        assert_eq!(
            worktree_fingerprint(amux::AgentType::ClaudeCode, Some("/tmp/a")),
            worktree_fingerprint(amux::AgentType::ClaudeCode, Some("/tmp/b"))
        );
    }
}
