//! Pure policy for global OpenCode serve env-snapshot conflicts.
//!
//! The host is device-wide: only one env fingerprint can be active at a time.
//! When a new attach resolves a different fingerprint, we must decide whether
//! to restart (nobody using the host), hard-fail (another workspace owns it),
//! or tolerate (same-workspace fingerprint jitter from cold cache / TTL).

/// Decision for an incoming workspace env fingerprint vs the running host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EnvSnapshotDecision {
    /// Fingerprints already match, or serve is not running — proceed normally.
    Continue,
    /// Fingerprint changed and no routes hold the host — safe to restart.
    RestartAllowed,
    /// Fingerprint changed, but every active route belongs to this workspace.
    /// Keep the running env; queue the new snapshot and recycle the serve when
    /// the last route detaches (`ServeSupervisor::apply_pending_env_if_idle`).
    TolerateSameWorkspace,
    /// Fingerprint changed and at least one other workspace still holds a route.
    ConflictOtherWorkspace,
}

/// Decide how to handle an env fingerprint mismatch (or match) at attach time.
///
/// `active_route_directories` are the canonical `Route.directory` values for
/// sessions currently registered on the global host.
pub(crate) fn decide_env_snapshot_conflict(
    incoming_fingerprint: &str,
    active_fingerprint: Option<&str>,
    serve_running: bool,
    active_route_directories: &[String],
    attaching_workspace: &str,
) -> EnvSnapshotDecision {
    if !serve_running || active_fingerprint == Some(incoming_fingerprint) {
        return EnvSnapshotDecision::Continue;
    }

    if active_route_directories.is_empty() {
        return EnvSnapshotDecision::RestartAllowed;
    }

    let only_same_workspace = active_route_directories
        .iter()
        .all(|directory| directory == attaching_workspace);
    if only_same_workspace {
        EnvSnapshotDecision::TolerateSameWorkspace
    } else {
        EnvSnapshotDecision::ConflictOtherWorkspace
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continue_when_fingerprints_match() {
        assert_eq!(
            decide_env_snapshot_conflict(
                "fp-a",
                Some("fp-a"),
                true,
                &["/ws-a".to_string()],
                "/ws-a",
            ),
            EnvSnapshotDecision::Continue
        );
    }

    #[test]
    fn restart_allowed_when_fingerprint_changed_and_routes_empty() {
        assert_eq!(
            decide_env_snapshot_conflict("fp-b", Some("fp-a"), true, &[], "/ws-a"),
            EnvSnapshotDecision::RestartAllowed
        );
    }

    #[test]
    fn tolerate_when_fingerprint_changed_and_only_same_workspace_routes() {
        assert_eq!(
            decide_env_snapshot_conflict(
                "fp-b",
                Some("fp-a"),
                true,
                &["/ws-a".to_string(), "/ws-a".to_string()],
                "/ws-a",
            ),
            EnvSnapshotDecision::TolerateSameWorkspace
        );
    }

    #[test]
    fn conflict_when_fingerprint_changed_and_other_workspace_holds_route() {
        assert_eq!(
            decide_env_snapshot_conflict(
                "fp-b",
                Some("fp-a"),
                true,
                &["/ws-a".to_string(), "/ws-b".to_string()],
                "/ws-a",
            ),
            EnvSnapshotDecision::ConflictOtherWorkspace
        );
    }

    #[test]
    fn continue_when_serve_not_running_even_if_fingerprints_differ() {
        assert_eq!(
            decide_env_snapshot_conflict("fp-b", Some("fp-a"), false, &[], "/ws-a"),
            EnvSnapshotDecision::Continue
        );
    }

    #[test]
    fn conflict_when_only_other_workspace_holds_route() {
        assert_eq!(
            decide_env_snapshot_conflict(
                "fp-b",
                Some("fp-a"),
                true,
                &["/ws-b".to_string()],
                "/ws-a",
            ),
            EnvSnapshotDecision::ConflictOtherWorkspace
        );
    }
}
