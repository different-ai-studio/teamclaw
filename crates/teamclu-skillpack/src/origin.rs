//! `<skill>/.clawhub/origin.json` — where an installed pack records where it
//! came from and what it looked like on arrival.
//!
//! # Why the baseline lives here and not in the lockfile
//!
//! The lockfile is workspace-scoped (`<workspace>/.clawhub/lock.json`) while
//! packs are global (`~/.agents/skills/<slug>`) — one copy on disk, referenced
//! by every workspace's lockfile, potentially at disagreeing versions. "Has
//! this directory been edited?" is a property of the directory, so asking it of
//! a workspace-scoped file forces an unanswerable "according to which
//! workspace?". Keeping the baseline beside the pack removes the question.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::manifest::FileManifest;

pub const ORIGIN_DIR: &str = ".clawhub";
const ORIGIN_FILE: &str = "origin.json";

/// 1 → 2 added `files`; 2 → 3 added `teamId`. Older payloads still
/// deserialize: v1 carries no baseline, which [`crate::inspect`] reads as
/// `Unmanaged` rather than as "clean", and v2 carries no team, which callers
/// have to treat as "unknown team" rather than as "mine".
pub const ORIGIN_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOrigin {
    pub version: u32,
    pub registry: String,
    pub slug: String,
    pub installed_version: String,
    pub installed_at: u64,
    /// Which team's registry this came from.
    ///
    /// Packs live in one flat root shared by every team the user belongs to, so
    /// without this a reconcile for team B sees team A's packs as "installed
    /// but not in my desired set" and deletes them. Absent on packs installed
    /// before this field existed — those are deliberately never removed, since
    /// "unknown team" is not evidence that they are ours to delete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// Absent on packs installed before manifests existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<FileManifest>,
}

fn origin_path(skill_dir: &Path) -> std::path::PathBuf {
    skill_dir.join(ORIGIN_DIR).join(ORIGIN_FILE)
}

/// `None` for anything unreadable or unparseable, deliberately: a corrupt
/// origin file means we cannot prove what the pack should look like, which is
/// the same position as having no baseline at all.
pub fn read_origin(skill_dir: &Path) -> Option<SkillOrigin> {
    let raw = std::fs::read_to_string(origin_path(skill_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_origin(skill_dir: &Path, origin: &SkillOrigin) -> std::io::Result<()> {
    let path = origin_path(skill_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(origin)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&path, format!("{}\n", json))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{build_manifest, inspect, DirtyState};

    #[test]
    fn round_trips_with_a_baseline() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("deploy-check");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: x\n---\nbody\n").unwrap();

        let files = build_manifest(&dir).unwrap();
        write_origin(
            &dir,
            &SkillOrigin {
                version: ORIGIN_VERSION,
                registry: "team".into(),
                slug: "deploy-check".into(),
                installed_version: "3".into(),
                installed_at: 1_754_880_000_000,
                team_id: Some("team-a".into()),
                files: Some(files),
            },
        )
        .unwrap();

        let read = read_origin(&dir).expect("origin");
        assert_eq!(read.installed_version, "3");
        assert_eq!(read.team_id.as_deref(), Some("team-a"));
        assert_eq!(inspect(&dir, read.files.as_ref()), DirtyState::Clean);
    }

    #[test]
    fn a_version_2_file_loads_with_no_team() {
        // Packs installed before the team was recorded. `team_id: None` is what
        // keeps them out of every team's removal set — reading it as "belongs
        // to whoever is asking" is how a team switch deletes them.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("legacy-v2");
        std::fs::create_dir_all(dir.join(ORIGIN_DIR)).unwrap();
        std::fs::write(dir.join("SKILL.md"), "body\n").unwrap();
        std::fs::write(
            dir.join(ORIGIN_DIR).join(ORIGIN_FILE),
            r#"{"version":2,"registry":"team","slug":"legacy-v2","installedVersion":"4","installedAt":1,"files":{}}"#,
        )
        .unwrap();

        let read = read_origin(&dir).expect("origin");
        assert_eq!(read.team_id, None);
    }

    #[test]
    fn a_version_1_file_still_loads_and_reports_unmanaged() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("legacy");
        std::fs::create_dir_all(dir.join(ORIGIN_DIR)).unwrap();
        std::fs::write(dir.join("SKILL.md"), "body\n").unwrap();
        std::fs::write(
            dir.join(ORIGIN_DIR).join(ORIGIN_FILE),
            r#"{"version":1,"registry":"clawhub","slug":"legacy","installedVersion":"1","installedAt":1}"#,
        )
        .unwrap();

        let read = read_origin(&dir).expect("origin");
        assert!(read.files.is_none());
        assert_eq!(inspect(&dir, read.files.as_ref()), DirtyState::Unmanaged);
    }
}
