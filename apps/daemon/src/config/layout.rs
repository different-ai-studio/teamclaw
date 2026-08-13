//! The one place `~/.amuxd` paths are constructed.
//!
//! Normative spec: `docs/architecture/amuxd-home-layout-v2.md`. The root holds
//! exactly the entries in [`teamclu_runtime_env::ROOT_ALLOWLIST`], and
//! [`tests::root_holds_only_allowlisted_entries`] is what keeps that true — the
//! old layout had no such rule, so every feature invented its own answer for
//! where to write and the root accumulated ~30 loose files.
//!
//! Adding a path here means answering one question first: *should this change
//! when the team changes?* Yes → `teams/<id>/state/` (PR ④b). No, and it is a
//! cache → [`cache_dir`]. No, and it dies with the process → [`run_dir`].

use std::path::PathBuf;

use super::DaemonConfig;

/// `~/.amuxd` (or `~/.amuxd-<brand>`, or `$AMUXD_HOME`).
pub fn root() -> PathBuf {
    DaemonConfig::config_dir()
}

/// Process runtime: pid, lock, control socket, HTTP discovery, child pgids.
///
/// Everything here is safe to delete while the daemon is stopped — it is
/// rebuilt on the next boot and describes *this* process, not any state.
pub fn run_dir() -> PathBuf {
    root().join("run")
}

/// Rotating daemon log.
pub fn logs_dir() -> PathBuf {
    root().join("logs")
}

/// Machine-level caches: keyed by backend or worktree, never by team. Deleting
/// any of it costs one cold probe and nothing else.
pub fn cache_dir() -> PathBuf {
    root().join("cache")
}

/// One directory per team.
pub fn teams_dir() -> PathBuf {
    root().join("teams")
}

/// Reserved directory name for a daemon that has not been claimed yet.
///
/// Unclaimed is a supported resting state (`DeferredBackend::unclaimed()`), and
/// the embedded `/v1/ui` chat can create sessions in it, so those writes need
/// somewhere to land. Giving them a directory means the code has exactly one
/// path — "the current team's directory" — instead of a `None` branch at every
/// write site. Team ids are UUIDs, so the leading underscore cannot collide.
pub const UNCLAIMED_TEAM: &str = "_unclaimed";

/// `teams/<id>`, or `teams/_unclaimed` when there is no team yet.
pub fn team_dir(team_id: &str) -> PathBuf {
    teams_dir().join(team_slug(team_id))
}

/// `teams/<id>/shared` — the **only** path the sync engine is allowed to scan.
///
/// Everything the daemon writes for a team is a sibling of this, never inside
/// it. That is what makes "will adding a file here push it to the cloud?"
/// answerable with a flat no: under the old layout the answer depended on which
/// level you added it at, and `cloud/` only escaped the scanner by being a
/// sibling of `teamclu-team/` — an implicit rule with nothing enforcing it.
pub fn team_shared_dir(team_id: &str) -> PathBuf {
    team_dir(team_id).join("shared")
}

/// `teams/<id>/state` — daemon-private, never synced.
pub fn team_state_dir(team_id: &str) -> PathBuf {
    team_dir(team_id).join("state")
}

/// `teams/<id>/workspace` — the writable default worktree for spawns that carry
/// no workspace of their own.
pub fn team_workspace_dir(team_id: &str) -> PathBuf {
    team_dir(team_id).join("workspace")
}

fn team_slug(team_id: &str) -> &str {
    let trimmed = team_id.trim();
    if trimmed.is_empty() {
        UNCLAIMED_TEAM
    } else {
        trimmed
    }
}

/// Create the fixed subdirectories so callers can write without each of them
/// re-deriving a `create_dir_all`. Best effort: a failure here surfaces at the
/// actual write, with a path in the message.
pub fn ensure() {
    for dir in [run_dir(), logs_dir(), cache_dir(), teams_dir()] {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::warn!(dir = %dir.display(), error = %e, "create amuxd layout dir failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_brand_env::BrandEnvGuard;
    use std::collections::BTreeSet;
    use teamclu_runtime_env::ROOT_ALLOWLIST;

    #[test]
    fn subdirectories_are_all_allowlisted() {
        let expected: BTreeSet<&str> = ROOT_ALLOWLIST.iter().copied().collect();
        for dir in ["run", "logs", "cache", "teams"] {
            assert!(
                expected.contains(dir),
                "{dir}/ is not in ROOT_ALLOWLIST — update the spec and the constant together"
            );
        }
    }

    /// The acceptance criterion from the spec, executable: after a full
    /// layout + config bootstrap, nothing unlisted exists at the root.
    #[test]
    fn root_holds_only_allowlisted_entries() {
        let home = tempfile::tempdir().unwrap();
        let _guard = BrandEnvGuard::set_amuxd_home(home.path());

        ensure();
        DaemonConfig::bootstrap()
            .save(&DaemonConfig::default_path())
            .unwrap();
        crate::device_id::daemon_device_id();

        let allowed: BTreeSet<&str> = ROOT_ALLOWLIST.iter().copied().collect();
        let found: BTreeSet<String> = std::fs::read_dir(root())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();

        let unexpected: Vec<&String> = found
            .iter()
            .filter(|name| !allowed.contains(name.as_str()))
            .collect();
        assert!(
            unexpected.is_empty(),
            "unlisted entries at the amuxd root: {unexpected:?}\n\
             Put it under run/, logs/, cache/ or teams/<id>/state/ — see \
             docs/architecture/amuxd-home-layout-v2.md §1."
        );
    }
}
