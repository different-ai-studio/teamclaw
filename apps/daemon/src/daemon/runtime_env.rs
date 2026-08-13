use std::path::Path;

use teamclu_runtime_env::ManagedLlmState;

use crate::runtime::execution_context::{ExecutionContext, IsolationDomainKey, WorkspaceIdentity};
use crate::runtime::{PermissionPolicy, SpawnRuntimeEnv};

use super::DaemonServer;

impl DaemonServer {
    pub(super) async fn assemble_execution_context(
        &self,
        working_directory: &str,
        workspace_root_hint: Option<&str>,
        workspace_id_hint: Option<&str>,
        is_gateway: bool,
        permission: Option<PermissionPolicy>,
    ) -> Result<ExecutionContext, String> {
        let team_id = self.config.team_id.as_deref();
        let workspace = if let Some(workspace_id) =
            workspace_id_hint.filter(|id| !id.trim().is_empty())
        {
            let resolved = self
                .workspace_resolver
                .resolve(workspace_id)
                .await
                .map_err(|e| format!("workspace identity resolution failed: {e}"))?;
            let identity = self
                .workspace_resolver
                .resolve_identity_for_path(Path::new(&resolved.path), resolved.team_id.as_deref())
                .await
                .ok_or_else(|| {
                    format!(
                        "workspace identity resolution failed: ambiguous or invalid workspace {workspace_id}"
                    )
                })?;
            if identity.workspace_id != workspace_id {
                return Err(format!(
                    "workspace identity mismatch: expected {workspace_id}, resolved {}",
                    identity.workspace_id
                ));
            }
            identity
        } else if let Some(root) = workspace_root_hint.filter(|root| !root.trim().is_empty()) {
            self.workspace_resolver
                .resolve_identity_for_path(Path::new(root), team_id)
                .await
                .ok_or_else(|| {
                    format!(
                        "workspace identity resolution failed for parent root {}",
                        Path::new(root).display()
                    )
                })?
        } else if !working_directory.trim().is_empty() {
            self.workspace_resolver
                .resolve_identity_for_path(Path::new(working_directory), team_id)
                .await
                .ok_or_else(|| {
                    format!(
                        "workspace identity resolution failed for working directory {}",
                        Path::new(working_directory).display()
                    )
                })?
        } else {
            self.workspace_resolver
                .resolve_default_workspace(team_id, &self.actor_id)
                .await
                .ok_or_else(|| {
                    "no working directory: configure a default workspace in Daemon > Workspace settings"
                        .to_string()
                })?
        };

        let working_directory = if working_directory.trim().is_empty() {
            workspace.workspace_root.clone()
        } else {
            Path::new(working_directory).to_path_buf()
        };
        let execution_workspace = self
            .workspace_resolver
            .resolve_identity_for_path(&working_directory, workspace.team_id.as_deref())
            .await
            .ok_or_else(|| {
                format!(
                    "working directory {} does not belong to resolved workspace {}",
                    working_directory.display(),
                    workspace.workspace_id
                )
            })?;
        if execution_workspace.workspace_id != workspace.workspace_id {
            return Err(format!(
                "working directory {} resolves to workspace {}, not hinted workspace {}",
                working_directory.display(),
                execution_workspace.workspace_id,
                workspace.workspace_id
            ));
        }
        let mut spawn_env = self
            .assemble_workspace_execution_env(&workspace, &working_directory)
            .await?;
        spawn_env.is_gateway = is_gateway;
        spawn_env.permission = permission;

        Ok(ExecutionContext {
            isolation_domain: IsolationDomainKey::Workspace(workspace.workspace_id.clone()),
            workspace: Some(workspace),
            working_directory,
            spawn_env,
        })
    }

    async fn assemble_workspace_execution_env(
        &self,
        workspace: &WorkspaceIdentity,
        working_directory: &Path,
    ) -> Result<SpawnRuntimeEnv, String> {
        let managed_llm = match workspace.team_id.as_deref() {
            Some(team_id) => self.resolve_managed_llm(team_id).await,
            None => ManagedLlmState::Unknown,
        };
        let cloud_token_file = self
            .backend
            .cloud_auth_health()
            .map(|_| crate::config::DaemonConfig::cloud_token_path())
            .map(|path| path.to_string_lossy().into_owned());

        self.suppress_internal_opencode_writes(working_directory.to_string_lossy().as_ref());
        crate::runtime::supervisor::materialize_inherent_mcp_for_spawn(working_directory)
            .map_err(|e| format!("materialize_inherent_mcp_for_spawn failed: {e}"))?;
        crate::runtime::env_assembly::assemble_spawn_runtime_env_for_execution(
            &workspace.workspace_root,
            working_directory,
            workspace.team_id.as_deref(),
            &self.config.actor.id,
            &self.config.actor.name,
            cloud_token_file.as_deref(),
            &managed_llm,
        )
        .map_err(|e| format!("assemble_runtime_env failed: {e}"))
    }

    /// Team ID is resolved from the cloud workspace row by UUID; on a cold resolver cache (e.g. right after daemon restart) a bare-agent spawn with an empty workspace_id yields None team_id until the cache warms — intentional under the cloud-source-of-truth / no-local-store design.
    pub(super) async fn resolve_workspace_team_id(&self, workspace_id: &str) -> Option<String> {
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

    /// Resolve real spawn envs for ALL of the team's linkable on-disk
    /// workspaces, for ACP host prewarming at daemon start. One entry per
    /// workspace: `(worktree_path, extra_env, force_env_override)`.
    ///
    /// Reusing `assemble_spawn_runtime_env_for_worktree` here is deliberate: it
    /// (a) syncs `provider.team` into each workspace's `opencode.json` (via
    /// `sync_team_provider_on_disk`) so the prewarmed host advertises the team
    /// model list, (b) warms the `managed_llm_cache` so the first real session
    /// skips the cloud round-trip, and (c) yields the exact `extra_env` the first
    /// `attach_session` will use, so the prewarmed host's `env_fingerprint`
    /// matches and gets reused.
    ///
    /// Covering every workspace (not just the first) matters because sessions
    /// and cron runs are not confined to the list head: cron's default
    /// workspace is the agent's `default_workspace_id`, which need not be the
    /// team list's first row. Workspaces whose env fails to assemble are
    /// skipped with a warning.
    ///
    /// Returns an empty vec when the team has no linkable workspace yet (fresh
    /// install) — the caller then falls back to an empty-env prewarm.
    pub(super) async fn resolve_all_prewarm_envs(
        &self,
    ) -> Vec<(String, std::collections::HashMap<String, String>, bool)> {
        let mut out = Vec::new();
        for ws in self.cloud_workspace_list().await {
            match self
                .assemble_spawn_runtime_env_for_worktree(&ws.path, &ws.workspace_id)
                .await
            {
                Ok(env) => out.push((ws.path, env.extra_env, env.force_env_override)),
                Err(e) => {
                    tracing::warn!(
                        workspace = %ws.path,
                        error = %e,
                        "prewarm: failed to assemble workspace env; skipping this workspace"
                    );
                }
            }
        }
        out
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
        let worktree_for_prewarm = worktree.to_string();
        tokio::spawn(async move {
            let mut mgr = agents.lock().await;
            mgr.prewarm_agent_backend_with_env(
                env.extra_env,
                env.force_env_override,
                Some(worktree_for_prewarm.as_str()),
            )
            .await;
        });
    }

    pub(super) async fn assemble_spawn_runtime_env_for_worktree(
        &self,
        worktree: &str,
        workspace_id: &str,
    ) -> Result<SpawnRuntimeEnv, String> {
        // Async lookups first — these must not race the refresh-watch suppress
        // window. Managed-LLM cloud fetch can exceed INTERNAL_WRITE_SUPPRESS
        // (3s); if we suppress *before* that await and only write afterward,
        // opencode.json rewrites leak as Pending "OpenCode config" banners.
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

        // Suppress immediately before sync disk writes (inherent MCP, then
        // provider.team + secret resolve via sync_team_provider_on_disk). Callers
        // must not rely on a suppress issued before the awaits above.
        self.suppress_internal_opencode_writes(worktree);
        crate::runtime::supervisor::materialize_inherent_mcp_for_spawn(Path::new(worktree))
            .map_err(|e| format!("materialize_inherent_mcp_for_spawn failed: {e}"))?;
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

    /// Cloud workspace id + local path for this daemon agent's default workspace.
    /// Uses the same resolution as cron and `GET /v1/agent/default-workspace`.
    pub(super) async fn resolve_default_workspace_for_publish(&self) -> (String, String) {
        let actor_id = &self.actor_id;
        let team_id = self.config.team_id.as_deref();

        let mut workspace_id = String::new();
        let mut worktree = String::new();

        if let Ok(defaults) = self.backend.get_agent_defaults(actor_id).await {
            if let Some(id) = defaults
                .default_workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                workspace_id = id.to_string();
                if let Ok(ws) = self.workspace_resolver.resolve(id).await {
                    let path = ws.path.trim();
                    if !path.is_empty() {
                        worktree = path.to_string();
                    }
                }
            }
        }

        if worktree.is_empty() {
            if let Some(path) = crate::config::resolve_default_workspace_path(
                &self.backend,
                &self.workspace_resolver,
                team_id,
                actor_id,
            )
            .await
            {
                worktree = path;
                if workspace_id.is_empty() {
                    if let Some(id) = self.workspace_resolver.id_for_path(&worktree).await {
                        workspace_id = id;
                    }
                }
            }
        }

        (workspace_id, worktree)
    }
}
