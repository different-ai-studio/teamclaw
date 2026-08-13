//! In-memory cache resolving cloud workspace UUIDs → `{path, team_id}`.
//!
//! `amux.workspaces` is the sole source of truth for workspace identity and
//! path. Callers that used to read a local `WorkspaceStore` row now resolve
//! through this cache instead, which fills lazily from the backend
//! (`Backend::get_workspaces_by_ids`) and never expires entries on its own —
//! callers must call `invalidate_all` when they know the cloud row changed
//! (e.g. `workspaces.changed` MQTT event or a local PATCH).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::backend::Backend;
use crate::runtime::execution_context::WorkspaceIdentity;

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
    cache: RwLock<WorkspaceCache>,
}

#[derive(Default)]
struct WorkspaceCache {
    entries: HashMap<String, ResolvedWorkspace>,
    loaded_teams: HashSet<String>,
    generation: u64,
}

impl WorkspaceResolver {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self {
            backend,
            cache: RwLock::new(WorkspaceCache::default()),
        }
    }

    /// UUID -> path/team_id; cache hit returns without a backend call, miss
    /// fetches via the backend and populates the cache. A cloud row with a
    /// null/empty path returns `PathMissing` (not cached).
    pub async fn resolve(&self, workspace_id: &str) -> Result<ResolvedWorkspace, ResolveError> {
        if let Some(hit) = self.cache.read().await.entries.get(workspace_id).cloned() {
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
            .entries
            .insert(workspace_id.to_string(), resolved.clone());

        Ok(resolved)
    }

    /// Reverse lookup: local `path` -> cached workspace id (used to backfill
    /// bare-spawn workspaces). Never triggers a cloud query.
    pub async fn id_for_path(&self, path: &str) -> Option<String> {
        self.cache
            .read()
            .await
            .entries
            .iter()
            .find(|(_, v)| v.path == path)
            .map(|(id, _)| id.clone())
    }

    /// Resolve an existing local directory to its registered cloud workspace
    /// identity. A workspace owns its root and descendants beneath its
    /// `.worktrees` directory, but not arbitrary sibling paths with the same
    /// textual prefix.
    pub async fn resolve_identity_for_path(
        &self,
        path: &Path,
        team_id: Option<&str>,
    ) -> Option<WorkspaceIdentity> {
        let candidate = path.canonicalize().ok()?;

        if let Some(team_id) = team_id.filter(|id| !id.trim().is_empty()) {
            loop {
                let (generation, needs_load) = {
                    let cache = self.cache.read().await;
                    (cache.generation, !cache.loaded_teams.contains(team_id))
                };
                if !needs_load {
                    break;
                }
                let rows = self.backend.get_workspaces_by_team(team_id).await.ok()?;
                if self.publish_team_rows(team_id, generation, rows).await {
                    break;
                }
            }
        }

        self.identity_from_cache(&candidate, team_id).await
    }

    /// Resolve an agent's configured default workspace, falling back to the
    /// first usable workspace registered for the supplied team.
    pub async fn resolve_default_workspace(
        &self,
        team_id: Option<&str>,
        actor_id: &str,
    ) -> Option<WorkspaceIdentity> {
        if let Ok(defaults) = self.backend.get_agent_defaults(actor_id).await {
            if let Some(id) = defaults.default_workspace_id.as_deref() {
                match self.resolve(id).await {
                    Ok(resolved) => {
                        if let Some(identity) = workspace_identity(id, &resolved) {
                            return Some(identity);
                        }
                    }
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

        let team_id = team_id.filter(|id| !id.trim().is_empty())?;
        let rows = self.backend.get_workspaces_by_team(team_id).await.ok()?;
        let conflicting_ids = conflicting_workspace_ids(&rows);

        rows.into_iter().find_map(|row| {
            let path = row.path.as_deref()?.trim();
            if path.is_empty()
                || conflicting_ids.contains(&row.id)
                || !super::workspace_path::is_linkable_workspace_path(path)
            {
                return None;
            }
            workspace_identity(
                &row.id,
                &ResolvedWorkspace {
                    path: path.to_string(),
                    team_id: if row.team_id.is_empty() {
                        None
                    } else {
                        Some(row.team_id)
                    },
                },
            )
        })
    }

    #[cfg(test)]
    async fn cache_generation(&self) -> u64 {
        self.cache.read().await.generation
    }

    async fn publish_team_rows(
        &self,
        team_id: &str,
        generation: u64,
        rows: Vec<crate::backend::WorkspaceRow>,
    ) -> bool {
        let conflicting_ids = conflicting_workspace_ids(&rows);
        let mut cache = self.cache.write().await;
        if cache.generation != generation {
            return false;
        }

        for row in rows {
            cache.entries.remove(&row.id);
            if conflicting_ids.contains(&row.id) {
                continue;
            }
            let Some(path) = row.path.filter(|path| !path.trim().is_empty()) else {
                continue;
            };
            cache.entries.insert(
                row.id,
                ResolvedWorkspace {
                    path: path.trim().to_string(),
                    team_id: if row.team_id.is_empty() {
                        None
                    } else {
                        Some(row.team_id)
                    },
                },
            );
        }
        cache.loaded_teams.insert(team_id.to_string());
        true
    }

    async fn identity_from_cache(
        &self,
        candidate: &Path,
        team_id: Option<&str>,
    ) -> Option<WorkspaceIdentity> {
        let cache = self.cache.read().await;
        select_workspace_identity(&cache.entries, candidate, team_id)
    }

    /// Clear the entire cache (call after receiving `workspaces.changed` or
    /// applying a local PATCH).
    pub async fn invalidate_all(&self) {
        let mut cache = self.cache.write().await;
        cache.entries.clear();
        cache.loaded_teams.clear();
        cache.generation = cache.generation.wrapping_add(1);
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

        // Surface ambiguous identity before caching: when several workspace
        // ids claim the same on-disk path, id→path resolution is non-unique and
        // a caller (e.g. a WeCom bot whose configured workspace_id fails to
        // resolve) can silently land on the wrong workspace (issue #551). Warn
        // loudly so the conflict is diagnosable rather than picked arbitrarily.
        for (path, ids) in conflicting_workspace_paths(&rows) {
            tracing::warn!(
                finding = "workspace_path_conflict",
                path = %path,
                workspace_ids = %ids.join(","),
                "multiple workspace records resolve to the same path; id→path resolution \
                 is ambiguous — sessions may route to the wrong workspace"
            );
        }

        let mut cache = self.cache.write().await;
        for row in rows {
            if let Some(path) = row.path.filter(|p| !p.is_empty()) {
                let team_id = if row.team_id.is_empty() {
                    None
                } else {
                    Some(row.team_id)
                };
                cache
                    .entries
                    .insert(row.id, ResolvedWorkspace { path, team_id });
            }
        }

        Ok(())
    }
}

fn conflicting_workspace_ids(rows: &[crate::backend::WorkspaceRow]) -> HashSet<String> {
    let exact_conflicts: HashSet<_> = conflicting_workspace_paths(rows)
        .into_iter()
        .map(|(path, _)| path)
        .collect();
    let mut conflicting_ids: HashSet<String> = rows
        .iter()
        .filter(|row| {
            row.path
                .as_deref()
                .map(str::trim)
                .is_some_and(|path| exact_conflicts.contains(path))
        })
        .map(|row| row.id.clone())
        .collect();

    let mut ids_by_canonical_root: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for row in rows {
        let Some(root) = row
            .path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .and_then(|path| Path::new(path).canonicalize().ok())
        else {
            continue;
        };
        let ids = ids_by_canonical_root.entry(root).or_default();
        if !ids.contains(&row.id) {
            ids.push(row.id.clone());
        }
    }
    for ids in ids_by_canonical_root.into_values() {
        if ids.len() > 1 {
            conflicting_ids.extend(ids);
        }
    }
    conflicting_ids
}

fn select_workspace_identity(
    entries: &HashMap<String, ResolvedWorkspace>,
    candidate: &Path,
    team_id: Option<&str>,
) -> Option<WorkspaceIdentity> {
    let candidates: Vec<_> = entries
        .iter()
        .filter(|(_, resolved)| team_id.is_none() || resolved.team_id.as_deref() == team_id)
        .filter_map(|(workspace_id, resolved)| {
            let canonical_root = Path::new(resolved.path.trim()).canonicalize().ok()?;
            let identity = workspace_identity(workspace_id, resolved)?;
            Some((canonical_root, identity))
        })
        .collect();
    let mut canonical_root_counts: HashMap<PathBuf, usize> = HashMap::new();
    for (canonical_root, _) in &candidates {
        *canonical_root_counts
            .entry(canonical_root.clone())
            .or_default() += 1;
    }

    candidates
        .into_iter()
        .filter(|(canonical_root, _)| canonical_root_counts[canonical_root] == 1)
        .filter(|(canonical_root, _)| owns_worktree(canonical_root, candidate))
        .max_by_key(|(canonical_root, _)| canonical_root.components().count())
        .map(|(_, identity)| identity)
}

fn workspace_identity(
    workspace_id: &str,
    resolved: &ResolvedWorkspace,
) -> Option<WorkspaceIdentity> {
    let workspace_root = PathBuf::from(resolved.path.trim());
    workspace_root
        .canonicalize()
        .ok()?
        .is_dir()
        .then(|| WorkspaceIdentity {
            workspace_id: workspace_id.to_string(),
            workspace_root,
            team_id: resolved.team_id.clone(),
        })
}

fn owns_worktree(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root.join(".worktrees"))
}

/// Group workspace rows by their (trimmed, non-empty) on-disk path and return
/// the paths that more than one *distinct* workspace id claims, each with its
/// sorted id list. Such collisions make id→path resolution ambiguous and are a
/// silent-fallback hazard (issue #551). Returns paths sorted for stable logs.
pub fn conflicting_workspace_paths(
    rows: &[crate::backend::WorkspaceRow],
) -> Vec<(String, Vec<String>)> {
    let mut by_path: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let Some(path) = row.path.as_deref().map(str::trim).filter(|p| !p.is_empty()) else {
            continue;
        };
        let ids = by_path.entry(path.to_string()).or_default();
        if !ids.contains(&row.id) {
            ids.push(row.id.clone());
        }
    }
    let mut conflicts: Vec<(String, Vec<String>)> = by_path
        .into_iter()
        .filter(|(_, ids)| ids.len() > 1)
        .map(|(path, mut ids)| {
            ids.sort();
            (path, ids)
        })
        .collect();
    conflicts.sort();
    conflicts
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
    _backend: &Arc<dyn Backend>,
    resolver: &WorkspaceResolver,
    team_id: Option<&str>,
    actor_id: &str,
) -> Option<String> {
    resolver
        .resolve_default_workspace(team_id, actor_id)
        .await
        .map(|identity| identity.workspace_root.to_string_lossy().into_owned())
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
                archived: false,
                agent_id: None,
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
    async fn resolve_identity_for_path_owns_root_and_worktrees_only() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("repo");
        let worktree = root.join(".worktrees/cron-job-run");
        let sibling = parent.path().join("repo-other");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();

        let mock = MockBackend::new();
        seed(
            &mock,
            "ws-a",
            "team-x",
            Some(root.to_string_lossy().as_ref()),
        );
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let resolver = WorkspaceResolver::new(backend);

        assert_eq!(
            resolver
                .resolve_identity_for_path(&root, Some("team-x"))
                .await
                .unwrap()
                .workspace_id,
            "ws-a"
        );
        assert_eq!(
            resolver
                .resolve_identity_for_path(&worktree, Some("team-x"))
                .await
                .unwrap()
                .workspace_id,
            "ws-a"
        );
        assert!(resolver
            .resolve_identity_for_path(&sibling, Some("team-x"))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn resolve_identity_for_path_returns_longest_matching_root() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("repo");
        let nested_root = root.join(".worktrees/nested");
        std::fs::create_dir_all(&nested_root).unwrap();

        let mock = MockBackend::new();
        seed(
            &mock,
            "ws-a",
            "team-x",
            Some(root.to_string_lossy().as_ref()),
        );
        seed(
            &mock,
            "ws-nested",
            "team-x",
            Some(nested_root.to_string_lossy().as_ref()),
        );
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let resolver = WorkspaceResolver::new(backend);

        assert_eq!(
            resolver
                .resolve_identity_for_path(&nested_root, Some("team-x"))
                .await
                .unwrap()
                .workspace_id,
            "ws-nested"
        );
    }

    #[tokio::test]
    async fn resolve_identity_for_path_rejects_duplicate_exact_roots() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_string_lossy();
        let mock = MockBackend::new();
        seed(&mock, "ws-a", "team-x", Some(path.as_ref()));
        seed(&mock, "ws-b", "team-x", Some(path.as_ref()));
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let resolver = WorkspaceResolver::new(backend);

        assert!(resolver
            .resolve_identity_for_path(root.path(), Some("team-x"))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn resolve_identity_for_path_rejects_canonical_root_collisions() {
        let root = tempfile::tempdir().unwrap();
        let canonical_spelling = root.path().to_string_lossy();
        let alias_spelling = root.path().join(".").to_string_lossy().into_owned();
        assert_ne!(canonical_spelling, alias_spelling);

        let mock = MockBackend::new();
        seed(
            &mock,
            "ws-canonical",
            "team-x",
            Some(canonical_spelling.as_ref()),
        );
        seed(&mock, "ws-alias", "team-x", Some(&alias_spelling));
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let resolver = WorkspaceResolver::new(backend);

        assert!(resolver
            .resolve_identity_for_path(root.path(), Some("team-x"))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn cache_only_identity_rejects_canonical_root_collisions() {
        let root = tempfile::tempdir().unwrap();
        let canonical_spelling = root.path().to_string_lossy();
        let alias_spelling = root.path().join(".").to_string_lossy().into_owned();
        let mock = MockBackend::new();
        seed(
            &mock,
            "ws-canonical",
            "team-x",
            Some(canonical_spelling.as_ref()),
        );
        seed(&mock, "ws-alias", "team-x", Some(&alias_spelling));
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let resolver = WorkspaceResolver::new(backend);
        resolver
            .warm(&["ws-canonical".into(), "ws-alias".into()])
            .await
            .unwrap();

        assert!(resolver
            .resolve_identity_for_path(root.path(), None)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn stale_team_load_cannot_publish_after_invalidation() {
        let old_root = tempfile::tempdir().unwrap();
        let new_root = tempfile::tempdir().unwrap();
        let mock = MockBackend::new();
        seed(
            &mock,
            "ws-old",
            "team-x",
            Some(old_root.path().to_string_lossy().as_ref()),
        );
        let state = mock.state.clone();
        let backend: Arc<dyn Backend> = Arc::new(mock);
        let resolver = Arc::new(WorkspaceResolver::new(backend));

        let generation = resolver.cache_generation().await;
        let stale_rows = vec![state
            .lock()
            .unwrap()
            .workspaces_by_id
            .get("ws-old")
            .unwrap()
            .clone()];
        let started = Arc::new(tokio::sync::Barrier::new(2));
        let release = Arc::new(tokio::sync::Notify::new());
        let loader = {
            let resolver = resolver.clone();
            let started = started.clone();
            let release = release.clone();
            tokio::spawn(async move {
                started.wait().await;
                release.notified().await;
                resolver
                    .publish_team_rows("team-x", generation, stale_rows)
                    .await;
            })
        };

        started.wait().await;
        resolver.invalidate_all().await;
        {
            let mut state = state.lock().unwrap();
            state.workspaces_by_id.clear();
            state.workspaces_by_id.insert(
                "ws-new".into(),
                WorkspaceRow {
                    id: "ws-new".into(),
                    team_id: "team-x".into(),
                    path: Some(new_root.path().to_string_lossy().into_owned()),
                    archived: false,
                    agent_id: None,
                },
            );
        }
        release.notify_one();
        loader.await.unwrap();

        assert_eq!(
            resolver
                .resolve_identity_for_path(new_root.path(), Some("team-x"))
                .await
                .unwrap()
                .workspace_id,
            "ws-new"
        );
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

    #[test]
    fn conflicting_workspace_paths_flags_duplicate_paths_only() {
        let rows = vec![
            WorkspaceRow {
                id: "ws-a".into(),
                team_id: "t".into(),
                path: Some("/tmp/shared".into()),
                archived: false,
                agent_id: None,
            },
            WorkspaceRow {
                id: "ws-b".into(),
                team_id: "t".into(),
                path: Some(" /tmp/shared ".into()),
                archived: false,
                agent_id: None,
            },
            WorkspaceRow {
                id: "ws-c".into(),
                team_id: "t".into(),
                path: Some("/tmp/unique".into()),
                archived: false,
                agent_id: None,
            },
            WorkspaceRow {
                id: "ws-d".into(),
                team_id: "t".into(),
                path: None,
                archived: false,
                agent_id: None,
            },
        ];
        let conflicts = conflicting_workspace_paths(&rows);
        // Only the shared path collides; trimming makes " /tmp/shared " match.
        assert_eq!(
            conflicts,
            vec![(
                "/tmp/shared".to_string(),
                vec!["ws-a".to_string(), "ws-b".to_string()]
            )]
        );
    }

    #[test]
    fn conflicting_workspace_paths_ignores_repeated_same_id() {
        // The same id appearing twice (e.g. duplicated in the fetch) is not a
        // conflict — only distinct ids sharing a path are.
        let rows = vec![
            WorkspaceRow {
                id: "ws-a".into(),
                team_id: "t".into(),
                path: Some("/tmp/x".into()),
                archived: false,
                agent_id: None,
            },
            WorkspaceRow {
                id: "ws-a".into(),
                team_id: "t".into(),
                path: Some("/tmp/x".into()),
                archived: false,
                agent_id: None,
            },
        ];
        assert!(conflicting_workspace_paths(&rows).is_empty());
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
