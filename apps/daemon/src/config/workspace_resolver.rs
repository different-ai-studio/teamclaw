//! In-memory cache resolving cloud workspace UUIDs → `{path, team_id}`.
//!
//! `amux.workspaces` is the sole source of truth for workspace identity and
//! path. Callers that used to read a local `WorkspaceStore` row now resolve
//! through this cache instead, which fills lazily from the backend
//! (`Backend::get_workspaces_by_ids`) and never expires entries on its own —
//! callers must call `invalidate_all` when they know the cloud row changed
//! (e.g. `workspaces.changed` MQTT event or a local PATCH).

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::backend::Backend;

#[derive(Debug, Clone)]
pub struct ResolvedWorkspace {
    pub path: String,
    pub team_id: Option<String>,
}

#[derive(Debug)]
pub enum ResolveError {
    NotFound(String),
    PathMissing(String),
    Backend(String),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::NotFound(id) => write!(f, "workspace {id} not found"),
            ResolveError::PathMissing(id) => write!(f, "workspace {id} has no path"),
            ResolveError::Backend(msg) => write!(f, "backend error: {msg}"),
        }
    }
}

impl std::error::Error for ResolveError {}

pub struct WorkspaceResolver {
    backend: Arc<dyn Backend>,
    cache: RwLock<HashMap<String, ResolvedWorkspace>>,
}

impl WorkspaceResolver {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            cache: RwLock::new(HashMap::new()),
        }
    }

    /// UUID -> path/team_id; cache hit returns without a backend call, miss
    /// fetches via the backend and populates the cache. A cloud row with a
    /// null/empty path returns `PathMissing` (not cached).
    pub async fn resolve(&self, workspace_id: &str) -> Result<ResolvedWorkspace, ResolveError> {
        if let Some(hit) = self.cache.read().await.get(workspace_id).cloned() {
            return Ok(hit);
        }

        let rows = self
            .backend
            .get_workspaces_by_ids(&[workspace_id.to_string()])
            .await
            .map_err(|e| ResolveError::Backend(e.to_string()))?;

        let row = rows
            .into_iter()
            .find(|r| r.id == workspace_id)
            .ok_or_else(|| ResolveError::NotFound(workspace_id.to_string()))?;

        let path = row
            .path
            .filter(|p| !p.is_empty())
            .ok_or_else(|| ResolveError::PathMissing(workspace_id.to_string()))?;

        let resolved = ResolvedWorkspace {
            path,
            team_id: if row.team_id.is_empty() {
                None
            } else {
                Some(row.team_id)
            },
        };

        self.cache
            .write()
            .await
            .insert(workspace_id.to_string(), resolved.clone());

        Ok(resolved)
    }

    /// Reverse lookup: local `path` -> cached workspace id (used to backfill
    /// bare-spawn workspaces). Never triggers a cloud query.
    pub async fn id_for_path(&self, path: &str) -> Option<String> {
        self.cache
            .read()
            .await
            .iter()
            .find(|(_, v)| v.path == path)
            .map(|(id, _)| id.clone())
    }

    /// Clear the entire cache (call after receiving `workspaces.changed` or
    /// applying a local PATCH).
    pub async fn invalidate_all(&self) {
        self.cache.write().await.clear();
    }

    /// Warm the cache with a batch of ids in one backend round trip
    /// (startup / team sweep). Entries with a missing path are skipped
    /// rather than failing the whole warm.
    pub async fn warm(&self, ids: &[String]) -> Result<(), ResolveError> {
        if ids.is_empty() {
            return Ok(());
        }

        let rows = self
            .backend
            .get_workspaces_by_ids(ids)
            .await
            .map_err(|e| ResolveError::Backend(e.to_string()))?;

        let mut cache = self.cache.write().await;
        for row in rows {
            if let Some(path) = row.path.filter(|p| !p.is_empty()) {
                let team_id = if row.team_id.is_empty() {
                    None
                } else {
                    Some(row.team_id)
                };
                cache.insert(row.id, ResolvedWorkspace { path, team_id });
            }
        }

        Ok(())
    }
}

/// Resolve an agent's default working directory: prefer the agent's cloud
/// `agents.default_workspace_id` (resolved to a filesystem path through
/// `resolver`'s cache), falling back to the team's first workspace whose
/// local path still exists on this machine (`Backend::get_workspaces_by_team`,
/// trusting only on-disk paths from the cloud row set).
///
/// Shared by `DaemonServer::resolve_cron_default_workspace` (daemon-local
/// cron turns, resolved for `self.actor_id`) and the HTTP
/// `GET /v1/agent/default-workspace` handler (resolved for the authenticated
/// principal's own actor id), so both callers apply the exact same
/// resolution + fallback algorithm.
pub async fn resolve_default_workspace_path(
    backend: &Arc<dyn Backend>,
    resolver: &WorkspaceResolver,
    team_id: Option<&str>,
    actor_id: &str,
) -> Option<String> {
    if let Ok(defaults) = backend.get_agent_defaults(actor_id).await {
        if let Some(id) = defaults.default_workspace_id.as_deref() {
            match resolver.resolve(id).await {
                Ok(resolved) => return Some(resolved.path),
                Err(e) => {
                    tracing::warn!(
                        workspace_id = %id,
                        "agent default workspace could not be resolved; \
                         falling back to team's first on-disk workspace: {e}"
                    );
                }
            }
        }
    }

    let team_id = team_id?;
    if team_id.trim().is_empty() {
        return None;
    }
    let rows = backend.get_workspaces_by_team(team_id).await.ok()?;
    rows.into_iter().find_map(|row| {
        let path = row.path?;
        let trimmed = path.trim();
        if trimmed.is_empty()
            || !super::workspace_path::is_linkable_workspace_path(trimmed)
            || !std::path::Path::new(trimmed).is_dir()
        {
            return None;
        }
        Some(trimmed.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mock::MockBackend;
    use crate::backend::{Backend, WorkspaceRow};

    fn seed(backend: &MockBackend, id: &str, team_id: &str, path: Option<&str>) {
        backend.state().workspaces_by_id.insert(
            id.to_string(),
            WorkspaceRow {
                id: id.to_string(),
                team_id: team_id.to_string(),
                path: path.map(str::to_string),
            },
        );
    }

    #[tokio::test]
    async fn resolve_caches_and_errors_on_missing_path() {
        let backend = Arc::new(MockBackend::new());
        seed(&backend, "ws-good", "team-x", Some("/tmp/good"));
        seed(&backend, "ws-null", "team-x", None);

        let backend: Arc<dyn Backend> = backend;
        let r = WorkspaceResolver::new(backend.clone());

        assert_eq!(r.resolve("ws-good").await.unwrap().path, "/tmp/good");
        assert!(matches!(
            r.resolve("ws-null").await,
            Err(ResolveError::PathMissing(_))
        ));

        // Second call for ws-good must hit cache: clear backend seed data,
        // resolve must still succeed.
        // (No direct downcast available here, so we just trust the cache is
        // consulted first per implementation — verified separately below.)
        assert_eq!(r.resolve("ws-good").await.unwrap().path, "/tmp/good");
    }

    #[tokio::test]
    async fn resolve_cache_hit_avoids_backend_call() {
        let mock = MockBackend::new();
        seed(&mock, "ws-good", "team-x", Some("/tmp/good"));
        let state = mock.state.clone();
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let r = WorkspaceResolver::new(backend);

        assert_eq!(r.resolve("ws-good").await.unwrap().path, "/tmp/good");

        // Remove the seeded row from backend state; a cache hit must not
        // need to call the backend again to succeed.
        state.lock().unwrap().workspaces_by_id.remove("ws-good");

        assert_eq!(r.resolve("ws-good").await.unwrap().path, "/tmp/good");
    }

    #[tokio::test]
    async fn resolve_unknown_id_returns_not_found() {
        let backend: Arc<dyn Backend> = Arc::new(MockBackend::new());
        let r = WorkspaceResolver::new(backend);

        assert!(matches!(
            r.resolve("ws-missing").await,
            Err(ResolveError::NotFound(id)) if id == "ws-missing"
        ));
    }

    #[tokio::test]
    async fn id_for_path_reverse_lookup_from_cache_only() {
        let mock = MockBackend::new();
        seed(&mock, "ws-good", "team-x", Some("/tmp/good"));
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let r = WorkspaceResolver::new(backend);

        assert_eq!(r.id_for_path("/tmp/good").await, None);

        r.resolve("ws-good").await.unwrap();

        assert_eq!(
            r.id_for_path("/tmp/good").await,
            Some("ws-good".to_string())
        );
        assert_eq!(r.id_for_path("/tmp/other").await, None);
    }

    #[tokio::test]
    async fn invalidate_all_clears_cache() {
        let mock = MockBackend::new();
        seed(&mock, "ws-good", "team-x", Some("/tmp/good"));
        let state = mock.state.clone();
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let r = WorkspaceResolver::new(backend);

        r.resolve("ws-good").await.unwrap();
        assert_eq!(
            r.id_for_path("/tmp/good").await,
            Some("ws-good".to_string())
        );

        r.invalidate_all().await;
        assert_eq!(r.id_for_path("/tmp/good").await, None);

        // Removing the backend seed proves invalidate_all really forces a
        // fresh backend round trip on the next resolve (it now fails).
        state.lock().unwrap().workspaces_by_id.remove("ws-good");
        assert!(matches!(
            r.resolve("ws-good").await,
            Err(ResolveError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn resolve_default_workspace_path_fallback_skips_non_linkable_path() {
        let _lock = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home.path());

        // Non-linkable: lives inside the daemon's own config dir (~/.amuxd/...).
        let non_linkable_dir = super::super::DaemonConfig::config_dir().join("teams/t1");
        std::fs::create_dir_all(&non_linkable_dir).unwrap();
        let non_linkable_path = non_linkable_dir.to_string_lossy().to_string();

        // Linkable: an ordinary on-disk tempdir outside the config dir.
        let linkable_dir = tempfile::tempdir().unwrap();
        let linkable_path = linkable_dir.path().to_string_lossy().to_string();

        let backend = Arc::new(MockBackend::new());
        // No agent default set, so this falls through to the team fallback.
        seed(&backend, "ws-bad", "team-x", Some(&non_linkable_path));
        seed(&backend, "ws-good", "team-x", Some(&linkable_path));

        let backend: Arc<dyn Backend> = backend;
        let resolver = WorkspaceResolver::new(backend.clone());

        let resolved =
            resolve_default_workspace_path(&backend, &resolver, Some("team-x"), "actor-1").await;

        assert_eq!(resolved, Some(linkable_path));
    }

    #[tokio::test]
    async fn warm_populates_cache_for_multiple_ids_skipping_missing_paths() {
        let mock = MockBackend::new();
        seed(&mock, "ws-a", "team-x", Some("/tmp/a"));
        seed(&mock, "ws-b", "team-x", Some("/tmp/b"));
        seed(&mock, "ws-null", "team-x", None);
        let state = mock.state.clone();
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let r = WorkspaceResolver::new(backend);

        r.warm(&[
            "ws-a".to_string(),
            "ws-b".to_string(),
            "ws-null".to_string(),
        ])
        .await
        .unwrap();

        // Backend cleared; warmed entries must resolve purely from cache.
        state.lock().unwrap().workspaces_by_id.clear();

        assert_eq!(r.resolve("ws-a").await.unwrap().path, "/tmp/a");
        assert_eq!(r.resolve("ws-b").await.unwrap().path, "/tmp/b");
        assert!(matches!(
            r.resolve("ws-null").await,
            Err(ResolveError::NotFound(_))
        ));
    }
}
