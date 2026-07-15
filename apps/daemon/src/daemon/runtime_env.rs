use std::path::Path;
use std::time::{Duration, Instant};

use teamclaw_runtime_env::{ManagedLlmModel, ManagedLlmProvider, ManagedLlmState};

use crate::runtime::SpawnRuntimeEnv;

use super::DaemonServer;

/// How long a cloud managed-LLM fetch is trusted before a refresh is attempted.
const MANAGED_LLM_TTL: Duration = Duration::from_secs(60);

/// A cached managed-LLM resolution plus when it was fetched. Stored per team_id
/// so a transient cloud failure can fall back to the last-known-good value
/// instead of wiping a working `provider.team`.
#[derive(Clone)]
pub(crate) struct CachedManagedLlm {
    fetched_at: Instant,
    state: ManagedLlmState,
}

impl DaemonServer {
    /// Team ID is resolved from the cloud workspace row by UUID; on a cold resolver cache (e.g. right after daemon restart) a bare-agent spawn with an empty workspace_id yields None team_id until the cache warms — intentional under the cloud-source-of-truth / no-local-store design.
    pub(super) async fn resolve_workspace_team_id(
        &self,
        workspace_id: &str,
    ) -> Option<String> {
        let fallback = || {
            self.config
                .team_id
                .as_ref()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
        };

        if workspace_id.is_empty() {
            // Bare-agent spawns have no workspace id; skip the guaranteed-miss
            // cloud lookup and go straight to the configured team fallback.
            return fallback();
        }

        self.workspace_resolver
            .resolve(workspace_id)
            .await
            .ok()
            .and_then(|w| w.team_id)
            .filter(|team_id| !team_id.trim().is_empty())
            .or_else(fallback)
    }

    /// Resolve the real spawn env for the team's primary (first linkable)
    /// workspace, for ACP host prewarming. Returns `(extra_env,
    /// force_env_override)`.
    ///
    /// Reusing `assemble_spawn_runtime_env_for_worktree` here is deliberate: it
    /// (a) writes `provider.team` into that workspace's `opencode.json` so the
    /// prewarmed host advertises the team model list, (b) warms the
    /// `managed_llm_cache` so the first real session skips the cloud round-trip,
    /// and (c) yields the exact `extra_env` the first `attach_session` will use,
    /// so the prewarmed host's `env_fingerprint` matches and gets reused.
    ///
    /// Returns `None` when the team has no linkable workspace yet (fresh install
    /// before any workspace is created) — the caller then falls back to an
    /// empty-env prewarm.
    pub(super) async fn resolve_primary_prewarm_env(
        &self,
    ) -> Option<(std::collections::HashMap<String, String>, bool)> {
        let ws = self.cloud_workspace_list().await.into_iter().next()?;
        match self
            .assemble_spawn_runtime_env_for_worktree(&ws.path, &ws.workspace_id)
            .await
        {
            Ok(env) => Some((env.extra_env, env.force_env_override)),
            Err(e) => {
                tracing::warn!(
                    workspace = %ws.path,
                    error = %e,
                    "prewarm: failed to assemble primary workspace env; falling back to empty-env prewarm"
                );
                None
            }
        }
    }

    /// Fire-and-forget: warm an ACP host for `worktree`'s real spawn env so the
    /// first session on this workspace skips the cold `initialize`. The env
    /// assembly (disk + short-TTL-cached managed LLM) runs inline and is quick;
    /// only the host spawn + `initialize` is detached. Safe to call repeatedly —
    /// `ensure_host` no-ops when a host with the same fingerprint already exists.
    pub(crate) async fn kick_prewarm_for_workspace(&self, worktree: &str, workspace_id: &str) {
        let env = match self
            .assemble_spawn_runtime_env_for_worktree(worktree, workspace_id)
            .await
        {
            Ok(env) => env,
            Err(e) => {
                tracing::warn!(worktree, error = %e, "prewarm-on-workspace-add: env assembly failed");
                return;
            }
        };
        let agents = self.agents.clone();
        tokio::spawn(async move {
            let mut mgr = agents.lock().await;
            mgr.prewarm_acp_hosts_with_env(env.extra_env, env.force_env_override)
                .await;
        });
    }

    pub(super) async fn assemble_spawn_runtime_env_for_worktree(
        &self,
        worktree: &str,
        workspace_id: &str,
    ) -> Result<SpawnRuntimeEnv, String> {
        let team_id = self.resolve_workspace_team_id(workspace_id).await;
        let managed_llm = match team_id.as_deref() {
            Some(tid) => self.resolve_managed_llm(tid).await,
            None => ManagedLlmState::Unknown,
        };
        // Only advertise the cloud-token file when there is a real cloud backend
        // maintaining it (mock backends have no auth surface). The refresher task
        // in `run()` is gated the same way, so the file exists whenever the path
        // is injected.
        let cloud_token_file = self
            .backend
            .cloud_auth_health()
            .map(|_| crate::config::DaemonConfig::cloud_token_path())
            .map(|p| p.to_string_lossy().into_owned());
        crate::runtime::env_assembly::assemble_spawn_runtime_env(
            Path::new(worktree),
            team_id.as_deref(),
            &self.config.actor.id,
            &self.config.actor.name,
            cloud_token_file.as_deref(),
            &managed_llm,
        )
        .map_err(|e| e.to_string())
    }

    /// Resolve the team's managed (shared) LLM directly from the cloud API, with
    /// a short-TTL in-memory cache. Replaces the old disk-mirrored
    /// `_meta/provider.json` read, which raced the first-install git clone and
    /// only converged after a daemon restart.
    ///
    /// On a transient fetch failure, falls back to the last-known cached value
    /// (or `Unknown` if none) so a working `provider.team` is never wiped by a
    /// blip. The first resolution per team also kicks a fire-and-forget
    /// member-key provisioning POST so LiteLLM actually mints the locally-derived
    /// `sk-tc-{actor}` key.
    async fn resolve_managed_llm(&self, team_id: &str) -> ManagedLlmState {
        if let Some(cached) = self.managed_llm_cache.lock().await.get(team_id) {
            if cached.fetched_at.elapsed() < MANAGED_LLM_TTL {
                return cached.state.clone();
            }
        }

        self.maybe_kick_member_key(team_id).await;

        match self.backend.managed_llm_config(team_id).await {
            Ok(cfg) => {
                let state = match (cfg.enabled, cfg.base_url) {
                    (true, Some(base_url)) => ManagedLlmState::Enabled(ManagedLlmProvider {
                        name: cfg.name.unwrap_or_default(),
                        base_url,
                        models: cfg
                            .models
                            .into_iter()
                            .map(|m| ManagedLlmModel {
                                id: m.id,
                                name: m.name,
                            })
                            .collect(),
                    }),
                    // Enabled but no base URL is unusable — treat as disabled.
                    _ => ManagedLlmState::Disabled,
                };
                self.managed_llm_cache.lock().await.insert(
                    team_id.to_string(),
                    CachedManagedLlm {
                        fetched_at: Instant::now(),
                        state: state.clone(),
                    },
                );
                state
            }
            Err(e) => {
                // Preserve last-known-good rather than wiping a working provider.
                let fallback = self
                    .managed_llm_cache
                    .lock()
                    .await
                    .get(team_id)
                    .map(|c| c.state.clone())
                    .unwrap_or(ManagedLlmState::Unknown);
                tracing::warn!(
                    team_id,
                    error = %e,
                    "managed LLM cloud fetch failed; using last-known managed LLM state"
                );
                fallback
            }
        }
    }

    /// Kick a one-time, fire-and-forget LiteLLM member-key provisioning POST for
    /// this team. Guarded so it runs at most once per team per process; failures
    /// are logged and ignored (the key value is derived locally regardless).
    async fn maybe_kick_member_key(&self, team_id: &str) {
        {
            let mut kicked = self.managed_llm_member_key_kicked.lock().await;
            if !kicked.insert(team_id.to_string()) {
                return;
            }
        }
        let backend = self.backend.clone();
        let tid = team_id.to_string();
        tokio::spawn(async move {
            if let Err(e) = backend.ensure_llm_member_key(&tid).await {
                tracing::warn!(team_id = %tid, error = %e, "LiteLLM member-key self-heal failed");
            }
        });
    }
}
