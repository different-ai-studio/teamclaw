use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use tokio::sync::RwLock;
use tokio::time::MissedTickBehavior;
use tracing::warn;
use walkdir::WalkDir;

use crate::config::global_team_store::TEAM_LINK_NAME;
use crate::runtime::RuntimeSupervisor;

use super::{RefreshChangeKind, RefreshSource, RuntimeRefreshCoordinator};

const WATCH_POLL_INTERVAL: Duration = Duration::from_millis(350);
const WATCH_DEBOUNCE_WINDOW: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchedWorkspace {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedChange {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
    pub kind: RefreshChangeKind,
}

#[derive(Debug)]
pub struct RefreshWatchRegistry {
    workspaces: RwLock<HashMap<PathBuf, WatchedWorkspace>>,
}

impl RefreshWatchRegistry {
    pub fn new(initial: Vec<WatchedWorkspace>) -> Arc<Self> {
        Arc::new(Self {
            workspaces: RwLock::new(
                initial
                    .into_iter()
                    .map(|workspace| (workspace.workspace_path.clone(), workspace))
                    .collect(),
            ),
        })
    }

    pub async fn upsert_workspace(&self, workspace: WatchedWorkspace) {
        self.workspaces
            .write()
            .await
            .insert(workspace.workspace_path.clone(), workspace);
    }

    pub async fn remove_workspace_path(&self, workspace_path: &Path) {
        self.workspaces.write().await.remove(workspace_path);
    }

    async fn snapshot(&self) -> Vec<WatchedWorkspace> {
        self.workspaces.read().await.values().cloned().collect()
    }

    #[cfg(test)]
    pub async fn workspace_paths(&self) -> Vec<PathBuf> {
        let mut paths: Vec<_> = self.workspaces.read().await.keys().cloned().collect();
        paths.sort();
        paths
    }
}

#[derive(Debug)]
pub struct RefreshDebounce {
    window: Duration,
    last_recorded_at: HashMap<(String, RefreshChangeKind), Instant>,
}

impl RefreshDebounce {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            last_recorded_at: HashMap::new(),
        }
    }

    pub fn recordable(
        &mut self,
        workspace_id: &str,
        kind: RefreshChangeKind,
        now: Instant,
    ) -> bool {
        let key = (workspace_id.to_string(), kind);
        if let Some(last_seen) = self.last_recorded_at.get(&key) {
            if now.duration_since(*last_seen) < self.window {
                return false;
            }
        }
        self.last_recorded_at.insert(key, now);
        true
    }
}

pub fn classify_change_path(
    path: &Path,
    workspaces: &[WatchedWorkspace],
    home: Option<&Path>,
) -> Vec<ClassifiedChange> {
    let mut changes = Vec::new();
    let mut seen = HashSet::new();

    let is_global_skill_path = home.is_some_and(|home_dir| {
        path.starts_with(home_dir.join(".config/teamclaw/skills"))
            || path.starts_with(home_dir.join(".config/opencode/skills"))
            || path.starts_with(home_dir.join(".claude/skills"))
            || path.starts_with(home_dir.join(".agents/skills"))
    });

    for workspace in workspaces {
        let kind = if path == workspace.workspace_path.join("opencode.json") {
            Some(RefreshChangeKind::OpencodeJson)
        } else if path == workspace.workspace_path.join(".teamclaw/teamclaw.json") {
            Some(RefreshChangeKind::TeamclawConfig)
        } else if path.starts_with(workspace.workspace_path.join(TEAM_LINK_NAME).join(".mcp")) {
            Some(RefreshChangeKind::Mcp)
        } else if path.starts_with(workspace.workspace_path.join(TEAM_LINK_NAME).join("_secrets"))
            || path.starts_with(workspace.workspace_path.join("teamclaw").join("_secrets"))
        {
            Some(RefreshChangeKind::EnvVars)
        } else if path.starts_with(workspace.workspace_path.join(".teamclaw/skills"))
            || path.starts_with(workspace.workspace_path.join(".opencode/skills"))
            || path.starts_with(workspace.workspace_path.join(".claude/skills"))
            || path.starts_with(workspace.workspace_path.join(".agents/skills"))
            || path.starts_with(workspace.workspace_path.join(TEAM_LINK_NAME).join("skills"))
            || is_global_skill_path
        {
            Some(RefreshChangeKind::Skills)
        } else {
            None
        };

        let Some(kind) = kind else {
            continue;
        };

        if seen.insert((workspace.workspace_id.clone(), kind)) {
            changes.push(ClassifiedChange {
                workspace_id: workspace.workspace_id.clone(),
                workspace_path: workspace.workspace_path.clone(),
                kind,
            });
        }
    }

    changes
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PathStamp {
    is_dir: bool,
    len: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

#[derive(Debug, Clone)]
struct WatchRoot {
    path: PathBuf,
    recursive: bool,
}

fn path_stamp(path: &Path) -> Option<PathStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let duration = modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    Some(PathStamp {
        is_dir: metadata.is_dir(),
        len: metadata.len(),
        modified_secs: duration.as_secs(),
        modified_nanos: duration.subsec_nanos(),
    })
}

fn snapshot_root(root: &WatchRoot) -> HashMap<PathBuf, PathStamp> {
    let mut snapshot = HashMap::new();
    if root.recursive {
        if !root.path.exists() {
            return snapshot;
        }
        for entry in WalkDir::new(&root.path).into_iter().filter_map(Result::ok) {
            let path = entry.path().to_path_buf();
            if let Some(stamp) = path_stamp(&path) {
                snapshot.insert(path, stamp);
            }
        }
        return snapshot;
    }

    if let Some(stamp) = path_stamp(&root.path) {
        snapshot.insert(root.path.clone(), stamp);
    }
    snapshot
}

fn diff_paths(
    previous: &HashMap<PathBuf, PathStamp>,
    current: &HashMap<PathBuf, PathStamp>,
) -> Vec<PathBuf> {
    let mut changed = Vec::new();
    let mut keys: HashSet<&PathBuf> = previous.keys().collect();
    keys.extend(current.keys());

    for key in keys {
        if previous.get(key) != current.get(key) {
            changed.push(key.clone());
        }
    }

    changed
}

fn watch_roots(workspaces: &[WatchedWorkspace], home: Option<&Path>) -> Vec<WatchRoot> {
    let mut roots = Vec::new();
    for workspace in workspaces {
        roots.push(WatchRoot {
            path: workspace.workspace_path.join("opencode.json"),
            recursive: false,
        });
        roots.push(WatchRoot {
            path: workspace.workspace_path.join(".teamclaw/teamclaw.json"),
            recursive: false,
        });
        roots.push(WatchRoot {
            path: workspace.workspace_path.join(".teamclaw/skills"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: workspace.workspace_path.join(".opencode/skills"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: workspace.workspace_path.join(".claude/skills"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: workspace.workspace_path.join(".agents/skills"),
            recursive: true,
        });
        let team_skills = workspace.workspace_path.join(TEAM_LINK_NAME).join("skills");
        roots.push(WatchRoot {
            path: team_skills,
            recursive: true,
        });
        roots.push(WatchRoot {
            path: workspace
                .workspace_path
                .join(TEAM_LINK_NAME)
                .join("_secrets"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: workspace.workspace_path.join("teamclaw").join("_secrets"),
            recursive: true,
        });
    }
    if let Some(home_dir) = home {
        roots.push(WatchRoot {
            path: home_dir.join(".config/teamclaw/skills"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: home_dir.join(".config/opencode/skills"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: home_dir.join(".claude/skills"),
            recursive: true,
        });
        roots.push(WatchRoot {
            path: home_dir.join(".agents/skills"),
            recursive: true,
        });
    }
    roots
}

async fn record_classified_changes(
    refresh: &RuntimeRefreshCoordinator,
    debounce: &mut RefreshDebounce,
    workspaces: &[WatchedWorkspace],
    home: Option<&Path>,
    path: &Path,
    now: Instant,
) {
    for change in classify_change_path(path, workspaces, home) {
        if !debounce.recordable(&change.workspace_id, change.kind, now) {
            continue;
        }
        if refresh.is_watch_suppressed(&change.workspace_id, change.kind) {
            continue;
        }
        if let Err(error) = refresh
            .record_change(
                &change.workspace_id,
                &change.workspace_path,
                change.kind,
                RefreshSource::FilesystemWatch,
            )
            .await
        {
            warn!(
                workspace_id = %change.workspace_id,
                workspace_path = %change.workspace_path.display(),
                changed_path = %path.display(),
                error = %error,
                "failed to record filesystem refresh change"
            );
        }
    }
}

pub fn start_refresh_watchers(
    refresh: Arc<RuntimeRefreshCoordinator>,
    workspaces: Vec<WatchedWorkspace>,
    home: Option<PathBuf>,
) -> Arc<RefreshWatchRegistry> {
    let registry = RefreshWatchRegistry::new(workspaces);
    let watch_registry = Arc::clone(&registry);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(WATCH_POLL_INTERVAL);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        let mut snapshots: HashMap<PathBuf, HashMap<PathBuf, PathStamp>> = HashMap::new();
        let mut debounce = RefreshDebounce::new(WATCH_DEBOUNCE_WINDOW);

        loop {
            interval.tick().await;

            let workspaces = watch_registry.snapshot().await;
            let roots = watch_roots(&workspaces, home.as_deref());
            let active_roots: HashSet<_> = roots.iter().map(|root| root.path.clone()).collect();
            snapshots.retain(|path, _| active_roots.contains(path));

            let mut changed_paths = Vec::new();
            for root in &roots {
                let next = snapshot_root(root);
                let previous = snapshots
                    .entry(root.path.clone())
                    .or_insert_with(|| next.clone());
                changed_paths.extend(diff_paths(previous, &next));
                *previous = next;
            }

            changed_paths.sort();
            changed_paths.dedup();

            for path in changed_paths {
                record_classified_changes(
                    &refresh,
                    &mut debounce,
                    &workspaces,
                    home.as_deref(),
                    &path,
                    Instant::now(),
                )
                .await;
            }
        }
    });

    registry
}

pub fn workspace_runtime_id(workspace_path: &Path) -> String {
    URL_SAFE_NO_PAD.encode(workspace_path.to_string_lossy().as_bytes())
}

pub fn suppress_for_workspace_path(
    coordinator: &super::RuntimeRefreshCoordinator,
    workspace_path: &Path,
    kinds: &[super::RefreshChangeKind],
    duration: std::time::Duration,
) {
    let workspace_id = workspace_runtime_id(workspace_path);
    coordinator.suppress_workspace_watch(&workspace_id, kinds, duration);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeManager;
    use tokio::sync::Mutex as AsyncMutex;

    fn watched_workspace(id: &str, path: &str) -> WatchedWorkspace {
        WatchedWorkspace {
            workspace_id: id.to_string(),
            workspace_path: PathBuf::from(path),
        }
    }

    #[test]
    fn skill_path_change_maps_to_skills_kind() {
        let workspaces = vec![watched_workspace("ws-1", "/tmp/ws-1")];
        let home = Path::new("/Users/tester");

        let cases = [
            (
                Path::new("/tmp/ws-1/.teamclaw/skills/demo-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/tmp/ws-1/.opencode/skills/demo-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/Users/tester/.config/teamclaw/skills/global-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/Users/tester/.config/opencode/skills/global-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/tmp/ws-1/.claude/skills/demo-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/tmp/ws-1/.agents/skills/demo-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/Users/tester/.claude/skills/global-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/Users/tester/.agents/skills/global-skill/SKILL.md"),
                RefreshChangeKind::Skills,
            ),
            (
                Path::new("/tmp/ws-1/opencode.json"),
                RefreshChangeKind::OpencodeJson,
            ),
            (
                Path::new("/tmp/ws-1/.teamclaw/teamclaw.json"),
                RefreshChangeKind::TeamclawConfig,
            ),
            (
                Path::new("/tmp/ws-1/teamclaw-team/_secrets/api_key.enc.json"),
                RefreshChangeKind::EnvVars,
            ),
            (
                Path::new("/tmp/ws-1/teamclaw/_secrets/legacy_key.enc.json"),
                RefreshChangeKind::EnvVars,
            ),
        ];

        for (path, kind) in cases {
            let changes = classify_change_path(path, &workspaces, Some(home));
            assert_eq!(
                changes,
                vec![ClassifiedChange {
                    workspace_id: "ws-1".to_string(),
                    workspace_path: PathBuf::from("/tmp/ws-1"),
                    kind,
                }],
                "path {} should classify to {:?}",
                path.display(),
                kind
            );
        }
    }

    #[tokio::test]
    async fn burst_events_are_debounced_into_one_recorded_change() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let workspaces = vec![watched_workspace("ws-1", "/tmp/ws-1")];
        let mut debounce = RefreshDebounce::new(Duration::from_millis(250));
        let now = Instant::now();
        let path = Path::new("/tmp/ws-1/.teamclaw/skills/demo-skill/SKILL.md");

        record_classified_changes(&coordinator, &mut debounce, &workspaces, None, path, now).await;
        record_classified_changes(
            &coordinator,
            &mut debounce,
            &workspaces,
            None,
            path,
            now + Duration::from_millis(50),
        )
        .await;
        record_classified_changes(
            &coordinator,
            &mut debounce,
            &workspaces,
            None,
            path,
            now + Duration::from_millis(100),
        )
        .await;

        let state = coordinator.workspace_state("ws-1").await.unwrap();
        assert_eq!(state.revision, 1);
        assert_eq!(state.change_kinds.len(), 1);
        assert!(state.change_kinds.contains(&RefreshChangeKind::Skills));
        assert_eq!(state.sources.len(), 1);
        assert!(state.sources.contains(&RefreshSource::FilesystemWatch));
    }

    #[tokio::test]
    async fn watcher_state_surfaces_through_runtime_status_with_http_workspace_id() {
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = workspace_runtime_id(dir.path());
        let workspaces = vec![WatchedWorkspace {
            workspace_id: workspace_id.clone(),
            workspace_path: dir.path().to_path_buf(),
        }];
        let manager = RuntimeManager::new(RuntimeManager::default_launch_configs(), None);
        let supervisor = RuntimeSupervisor::new(Arc::new(AsyncMutex::new(manager)));
        let mut debounce = RefreshDebounce::new(Duration::from_millis(250));

        record_classified_changes(
            &supervisor.refresh_coordinator(),
            &mut debounce,
            &workspaces,
            None,
            &dir.path().join(".teamclaw/skills/demo-skill/SKILL.md"),
            Instant::now(),
        )
        .await;

        let status = supervisor
            .runtime_status(&workspace_id, dir.path())
            .await
            .unwrap();
        assert_eq!(status.refresh.status, "pending");
        assert_eq!(status.refresh.change_kinds, vec!["skills".to_string()]);
    }

    #[tokio::test]
    async fn watcher_skips_record_change_when_suppressed() {
        let coordinator = RuntimeRefreshCoordinator::new();
        let dir = tempfile::tempdir().unwrap();
        let workspace_id = workspace_runtime_id(dir.path());
        let workspaces = vec![WatchedWorkspace {
            workspace_id: workspace_id.clone(),
            workspace_path: dir.path().to_path_buf(),
        }];
        let mut debounce = RefreshDebounce::new(Duration::from_millis(250));

        coordinator.suppress_workspace_watch(
            &workspace_id,
            &[RefreshChangeKind::OpencodeJson],
            Duration::from_secs(5),
        );

        std::fs::write(
            dir.path().join("opencode.json"),
            r#"{"$schema":"https://opencode.ai/config.json"}"#,
        )
        .unwrap();

        record_classified_changes(
            &coordinator,
            &mut debounce,
            &workspaces,
            None,
            &dir.path().join("opencode.json"),
            Instant::now(),
        )
        .await;

        assert!(coordinator.workspace_state(&workspace_id).await.is_none());
    }

    #[tokio::test]
    async fn watch_registry_supports_add_and_remove() {
        let registry = RefreshWatchRegistry::new(Vec::new());
        registry
            .upsert_workspace(watched_workspace("ws-1", "/tmp/ws-1"))
            .await;
        registry
            .upsert_workspace(watched_workspace("ws-2", "/tmp/ws-2"))
            .await;
        assert_eq!(
            registry.workspace_paths().await,
            vec![PathBuf::from("/tmp/ws-1"), PathBuf::from("/tmp/ws-2")]
        );

        registry.remove_workspace_path(Path::new("/tmp/ws-1")).await;
        assert_eq!(
            registry.workspace_paths().await,
            vec![PathBuf::from("/tmp/ws-2")]
        );
    }
}
