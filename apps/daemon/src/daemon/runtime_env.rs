use std::path::Path;

use teamclaw_runtime_env::ManagedLlmState;

use crate::runtime::SpawnRuntimeEnv;

use super::DaemonServer;

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

    /// Resolve the team's managed (shared) LLM via the shared TTL-cached
    /// resolver, which the HTTP provider snapshot uses too — so a provider read
    /// and a spawn share one throttled cloud fetch.
    async fn resolve_managed_llm(&self, team_id: &str) -> ManagedLlmState {
        self.managed_llm.resolve(team_id).await
    }
}
