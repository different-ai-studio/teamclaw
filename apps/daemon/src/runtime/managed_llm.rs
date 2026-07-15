//! Cloud-sourced managed (shared) LLM resolution, shared by the spawn path and
//! the HTTP provider snapshot.
//!
//! `provider.team` in a workspace's `opencode.json` is materialized from the
//! team's cloud LLM config. It used to be written *only* while assembling a
//! spawn env, which meant an admin changing the team's model list never reached
//! a member until that member happened to spawn a fresh runtime — the daemon's
//! `GET /v1/workspaces/:id/providers` reads the same file straight off disk, so
//! the stale list survived app restarts.
//!
//! Holding the TTL cache here (rather than on `DaemonServer`) lets both callers
//! share one throttled cloud fetch, so reconciling on a provider read costs at
//! most one request per team per [`MANAGED_LLM_TTL`].

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

use teamclaw_runtime_env::{ManagedLlmModel, ManagedLlmProvider, ManagedLlmState};

use crate::backend::Backend;

/// How long a cloud managed-LLM fetch is trusted before a refresh is attempted.
const MANAGED_LLM_TTL: Duration = Duration::from_secs(60);

/// A cached managed-LLM resolution plus when it was fetched. Stored per team_id
/// so a transient cloud failure can fall back to the last-known-good value
/// instead of wiping a working `provider.team`.
#[derive(Clone)]
struct CachedManagedLlm {
    fetched_at: Instant,
    state: ManagedLlmState,
}

pub struct ManagedLlmResolver {
    backend: Arc<dyn Backend>,
    cache: AsyncMutex<HashMap<String, CachedManagedLlm>>,
    member_key_kicked: AsyncMutex<HashSet<String>>,
}

impl ManagedLlmResolver {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            cache: AsyncMutex::new(HashMap::new()),
            member_key_kicked: AsyncMutex::new(HashSet::new()),
        }
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
    pub async fn resolve(&self, team_id: &str) -> ManagedLlmState {
        if let Some(cached) = self.cache.lock().await.get(team_id) {
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
                self.cache.lock().await.insert(
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
                    .cache
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

    /// Re-materialize `provider.team` in `workspace`'s `opencode.json` from the
    /// team's current cloud LLM config.
    ///
    /// Safe to call on every provider read: the cloud fetch is TTL-throttled and
    /// `ensure_team_provider` only writes when the entry actually differs, so a
    /// steady state performs no writes and does not churn the refresh watcher.
    /// A `Unknown` resolution (no fresh cloud answer) leaves the file untouched.
    pub async fn reconcile_workspace(&self, workspace: &Path, team_id: &str) {
        let state = self.resolve(team_id).await;
        if let Err(e) = teamclaw_runtime_env::team_provider::ensure_team_provider(workspace, &state)
        {
            tracing::warn!(
                team_id,
                workspace = %workspace.display(),
                error = %e,
                "failed to reconcile provider.team from cloud managed LLM"
            );
        }
    }

    /// Kick a one-time, fire-and-forget LiteLLM member-key provisioning POST for
    /// this team. Guarded so it runs at most once per team per process; failures
    /// are logged and ignored (the key value is derived locally regardless).
    async fn maybe_kick_member_key(&self, team_id: &str) {
        {
            let mut kicked = self.member_key_kicked.lock().await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mock::MockBackend;
    use crate::backend::{ManagedLlmConfig, ManagedLlmModelInfo};

    fn config_with_models(models: &[&str]) -> ManagedLlmConfig {
        ManagedLlmConfig {
            enabled: true,
            base_url: Some("https://gateway.example/v1".to_string()),
            name: Some("Team".to_string()),
            models: models
                .iter()
                .map(|id| ManagedLlmModelInfo {
                    id: (*id).to_string(),
                    name: (*id).to_string(),
                })
                .collect(),
        }
    }

    fn team_model_ids(workspace: &Path) -> Vec<String> {
        let raw = std::fs::read_to_string(workspace.join("opencode.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut ids: Vec<String> = json["provider"]["team"]["models"]
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        ids.sort();
        ids
    }

    /// The bug: an admin swapping the team's models left members on the old list
    /// because `provider.team` was only ever written while assembling a spawn
    /// env. Reconciling has to replace the list on disk, not union into it.
    #[tokio::test]
    async fn reconcile_replaces_the_team_model_list_from_cloud() {
        let workspace = tempfile::TempDir::new().unwrap();
        let mock = MockBackend::with_identity("team-x", "actor-x");
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), config_with_models(&["model-a"]));
        let backend: Arc<dyn Backend> = Arc::new(mock.clone());
        let resolver = ManagedLlmResolver::new(backend);

        resolver
            .reconcile_workspace(workspace.path(), "team-x")
            .await;
        assert_eq!(
            team_model_ids(workspace.path()),
            vec!["model-a".to_string()]
        );

        // Admin swaps the team onto a new set. The TTL cache would otherwise
        // hold the old answer, so drop it the way a 60s expiry would.
        mock.state().managed_llm_configs.insert(
            "team-x".to_string(),
            config_with_models(&["model-b", "model-c"]),
        );
        resolver.cache.lock().await.clear();

        resolver
            .reconcile_workspace(workspace.path(), "team-x")
            .await;
        assert_eq!(
            team_model_ids(workspace.path()),
            vec!["model-b".to_string(), "model-c".to_string()],
            "the dropped model must not survive the reconcile"
        );
    }

    /// A resolution inside the TTL must not hit the cloud again — provider reads
    /// are frequent, and reconciling on each one must stay cheap.
    #[tokio::test]
    async fn resolve_is_ttl_cached() {
        let mock = MockBackend::with_identity("team-x", "actor-x");
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), config_with_models(&["model-a"]));
        let backend: Arc<dyn Backend> = Arc::new(mock.clone());
        let resolver = ManagedLlmResolver::new(backend);

        resolver.resolve("team-x").await;
        // Swap the cloud answer; the cached one must still win.
        mock.state()
            .managed_llm_configs
            .insert("team-x".to_string(), config_with_models(&["model-b"]));

        match resolver.resolve("team-x").await {
            ManagedLlmState::Enabled(provider) => {
                assert_eq!(provider.models[0].id, "model-a");
            }
            other => panic!("expected Enabled, got {other:?}"),
        }
    }

    /// A cloud blip must not strip a working `provider.team`.
    #[tokio::test]
    async fn unknown_state_leaves_disk_untouched() {
        let workspace = tempfile::TempDir::new().unwrap();
        std::fs::write(
            workspace.path().join("opencode.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "provider": { "team": { "models": { "model-a": { "name": "Model A" } } } }
            }))
            .unwrap(),
        )
        .unwrap();

        // MockBackend with no seeded config resolves to Disabled, not Unknown,
        // so drive the untouched path through `ensure_team_provider` directly.
        teamclaw_runtime_env::team_provider::ensure_team_provider(
            workspace.path(),
            &ManagedLlmState::Unknown,
        )
        .unwrap();

        assert_eq!(
            team_model_ids(workspace.path()),
            vec!["model-a".to_string()]
        );
    }
}
