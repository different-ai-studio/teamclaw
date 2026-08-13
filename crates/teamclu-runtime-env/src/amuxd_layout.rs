//! The amuxd home's internal layout — one definition for daemon and desktop.
//!
//! The daemon's `config::layout` and the desktop's `commands::amuxd_*` helpers
//! both delegate here, so a layout change is one edit instead of a mirrored
//! pair held together by a comment. Spec: `docs/architecture/amuxd-home-layout-v2.md`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// Reserved directory name for a daemon that has not been claimed yet.
pub const UNCLAIMED_TEAM: &str = "_unclaimed";

pub fn run_dir(home: &Path) -> PathBuf {
    home.join("run")
}

pub fn logs_dir(home: &Path) -> PathBuf {
    home.join("logs")
}

pub fn cache_dir(home: &Path) -> PathBuf {
    home.join("cache")
}

pub fn teams_dir(home: &Path) -> PathBuf {
    home.join("teams")
}

fn team_slug(team_id: &str) -> &str {
    let trimmed = team_id.trim();
    if trimmed.is_empty() {
        UNCLAIMED_TEAM
    } else {
        trimmed
    }
}

pub fn team_dir(home: &Path, team_id: &str) -> PathBuf {
    teams_dir(home).join(team_slug(team_id))
}

pub fn team_state_dir(home: &Path, team_id: &str) -> PathBuf {
    team_dir(home, team_id).join("state")
}

pub fn team_shared_dir(home: &Path, team_id: &str) -> PathBuf {
    team_dir(home, team_id).join("shared")
}

pub fn team_workspace_dir(home: &Path, team_id: &str) -> PathBuf {
    team_dir(home, team_id).join("workspace")
}

/// Just enough of `daemon.toml` to find the active team: path resolution must
/// not fail because an unrelated section stopped parsing.
#[derive(serde::Deserialize)]
struct ActiveTeamProbe {
    /// `active_team` on disk; `team_id` was the interim spelling.
    #[serde(default, alias = "team_id")]
    active_team: Option<String>,
}

/// The team the daemon under `home` is claimed by, or [`UNCLAIMED_TEAM`].
///
/// Mtime-cached: path helpers run on hot paths (every persisted message
/// resolves one), and the pointer changes only at claim time, so a stat
/// replaces a read + parse in the common case.
pub fn active_team(home: &Path) -> String {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (SystemTime, String)>>> = OnceLock::new();

    let path = home.join("daemon.toml");
    let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) else {
        return UNCLAIMED_TEAM.to_string();
    };

    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((cached_mtime, team)) = cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&path)
        .filter(|(m, _)| *m == modified)
    {
        let _ = cached_mtime;
        return team.clone();
    }

    let team = std::fs::read_to_string(&path)
        .ok()
        .and_then(|body| toml::from_str::<ActiveTeamProbe>(&body).ok())
        .and_then(|probe| probe.active_team)
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| UNCLAIMED_TEAM.to_string());

    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path, (modified, team.clone()));
    team
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_team_probe_and_cache_follow_the_file() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(active_team(home.path()), UNCLAIMED_TEAM);

        std::fs::write(home.path().join("daemon.toml"), "active_team = \"t1\"\n").unwrap();
        assert_eq!(active_team(home.path()), "t1");
        // Cached read returns the same answer.
        assert_eq!(active_team(home.path()), "t1");

        // Garbage must not take path resolution down with it.
        std::fs::write(home.path().join("daemon.toml"), "active_team = [").unwrap();
        assert_eq!(active_team(home.path()), UNCLAIMED_TEAM);
    }

    #[test]
    fn empty_team_id_is_unclaimed() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            team_dir(home.path(), "  "),
            teams_dir(home.path()).join(UNCLAIMED_TEAM)
        );
    }
}
