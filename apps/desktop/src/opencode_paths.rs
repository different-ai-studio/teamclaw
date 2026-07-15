//! Canonical OpenCode global data paths (shared across desktop sidecar, cache, skills).
//!
//! TeamClaw no longer injects per-workspace `XDG_*` overrides; OpenCode uses the
//! user's default global directories. Workspace-local paths under `.opencode/skills`
//! and `opencode.json` remain project-scoped.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Global OpenCode data root: `~/.local/share/opencode`.
pub fn global_opencode_data_dir(home: &Path) -> PathBuf {
    home.join(".local/share/opencode")
}

/// Global OpenCode SQLite DB: `~/.local/share/opencode/opencode.db`.
pub fn global_opencode_db_path(home: &Path) -> PathBuf {
    global_opencode_data_dir(home).join("opencode.db")
}

/// Global OpenCode skills directory: `~/.config/opencode/skills`.
pub fn global_opencode_config_skills_dir(home: &Path) -> PathBuf {
    home.join(".config/opencode/skills")
}

/// TeamClaw plugin update throttle file under the global XDG state dir.
pub fn global_plugin_update_state_path(home: &Path) -> PathBuf {
    home.join(".local/state/plugin-update-check.json")
}

/// OpenCode npm plugin cache directory for a normalized package spec key.
pub fn global_plugin_cache_dir(home: &Path, normalized_spec_key: &str) -> PathBuf {
    home.join(".cache/opencode/packages")
        .join(normalized_spec_key)
}

/// Legacy per-workspace isolated DB from the old XDG-redirect layout.
pub fn isolated_opencode_db_path(workspace_path: &Path) -> PathBuf {
    workspace_path.join(".opencode/data/opencode/opencode.db")
}

/// Candidate DB paths in lookup order (deduped).
pub fn opencode_db_candidates(workspace_path: Option<&str>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(path) = std::env::var("OPENCODE_DB_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            paths.push(PathBuf::from(trimmed));
        }
    }

    if let Some(home) = home {
        paths.push(global_opencode_db_path(home));
    }

    if let Some(workspace_path) = workspace_path.map(str::trim).filter(|p| !p.is_empty()) {
        paths.push(isolated_opencode_db_path(Path::new(workspace_path)));
    }

    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

/// Resolve the first existing OpenCode DB among global, legacy-isolated, and env override.
pub fn resolve_opencode_db_path(workspace_path: &str) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "HOME directory not found".to_string())?;
    let candidates = opencode_db_candidates(Some(workspace_path), Some(&home));

    for path in &candidates {
        if path.exists() {
            return Ok(path.to_string_lossy().into_owned());
        }
    }

    let tried = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!("OpenCode database not found. Checked: {tried}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn global_paths_follow_opencode_defaults() {
        let home = Path::new("/home/tester");
        assert_eq!(
            global_opencode_db_path(home),
            PathBuf::from("/home/tester/.local/share/opencode/opencode.db")
        );
        assert_eq!(
            global_opencode_config_skills_dir(home),
            PathBuf::from("/home/tester/.config/opencode/skills")
        );
        assert_eq!(
            global_plugin_update_state_path(home),
            PathBuf::from("/home/tester/.local/state/plugin-update-check.json")
        );
        assert_eq!(
            global_plugin_cache_dir(home, "pkg@latest"),
            PathBuf::from("/home/tester/.cache/opencode/packages/pkg@latest")
        );
    }

    #[test]
    fn opencode_db_candidates_prefers_global_before_isolated() {
        let home = Path::new("/home/tester");
        let workspace = "/tmp/ws";
        let candidates = opencode_db_candidates(Some(workspace), Some(home));

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0], global_opencode_db_path(home));
        assert_eq!(
            candidates[1],
            isolated_opencode_db_path(Path::new(workspace))
        );
    }

    #[test]
    fn resolve_opencode_db_path_prefers_global_db() {
        let workspace_dir = tempdir().unwrap();
        let home_dir = tempdir().unwrap();
        let _home_guard = HomeGuard::set(home_dir.path());

        let global_db = global_opencode_db_path(home_dir.path());
        std::fs::create_dir_all(global_db.parent().unwrap()).unwrap();
        std::fs::write(&global_db, b"global").unwrap();

        let isolated_db = isolated_opencode_db_path(workspace_dir.path());
        std::fs::create_dir_all(isolated_db.parent().unwrap()).unwrap();
        std::fs::write(&isolated_db, b"isolated").unwrap();

        let resolved = resolve_opencode_db_path(workspace_dir.path().to_str().unwrap()).unwrap();
        assert_eq!(resolved, global_db.to_string_lossy());
    }

    #[test]
    fn resolve_opencode_db_path_falls_back_to_isolated_db() {
        let workspace_dir = tempdir().unwrap();
        let home_dir = tempdir().unwrap();
        let _home_guard = HomeGuard::set(home_dir.path());

        let isolated_db = isolated_opencode_db_path(workspace_dir.path());
        std::fs::create_dir_all(isolated_db.parent().unwrap()).unwrap();
        std::fs::write(&isolated_db, b"isolated").unwrap();

        let resolved = resolve_opencode_db_path(workspace_dir.path().to_str().unwrap()).unwrap();
        assert_eq!(resolved, isolated_db.to_string_lossy());
    }

    struct HomeGuard;

    impl HomeGuard {
        fn set(path: &Path) -> Self {
            std::env::set_var("HOME", path);
            Self
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            std::env::remove_var("HOME");
        }
    }
}
