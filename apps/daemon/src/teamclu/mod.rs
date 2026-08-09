#[path = "idea_store.rs"]
pub mod idea_store;
pub mod live;
pub mod message_store;
pub mod notify;
pub mod rpc;
pub mod session_manager;
pub mod session_store;

use std::path::Path;

/// Pre-rebrand name of the daemon's session-state directory under its amuxd
/// home (`~/.amuxd/teamclaw/`).
const LEGACY_STATE_DIR: &str = "teamclaw";
const STATE_DIR: &str = "teamclu";

/// One-shot move of `<amuxd home>/teamclaw/` → `<amuxd home>/teamclu/`.
///
/// Sessions, messages and ideas are real user data and the desktop's storage
/// migration does not reach them — that one covers `~/.teamclaw` and workspace
/// metadata, while this tree lives under the daemon's own home. Without this the
/// rename silently presents every existing device as having no history.
///
/// Runs before the first store read (see `SessionManager::new`). A pre-existing
/// destination means a post-rebrand daemon already owns this tree, so the move
/// is skipped rather than merged: these are TOML documents, and interleaving two
/// generations of them corrupts rather than combines.
pub fn migrate_rebrand_state_dir(base_dir: &Path) {
    let legacy = base_dir.join(LEGACY_STATE_DIR);
    let canonical = base_dir.join(STATE_DIR);
    if !legacy.is_dir() || canonical.exists() {
        return;
    }
    match std::fs::rename(&legacy, &canonical) {
        Ok(()) => tracing::info!(
            "migrated daemon session state {} -> {}",
            legacy.display(),
            canonical.display()
        ),
        Err(err) => tracing::warn!(
            "failed to migrate daemon session state {} -> {}: {err}",
            legacy.display(),
            canonical.display()
        ),
    }
}

pub use idea_store::{IdeaStore, StoredClaim, StoredIdea, StoredSubmission};
pub use live::LivePublisher;
pub use message_store::{MessageStore, StoredMessage};
pub use notify::NotifyPublisher;
pub use rpc::RpcServer;
pub use session_manager::SessionManager;
pub use session_store::{StoredParticipant, StoredSession, TeamcluSessionStore};

#[cfg(test)]
mod rebrand_migration_tests {
    use super::*;

    #[test]
    fn moves_pre_rebrand_state_dir() {
        let base = tempfile::tempdir().unwrap();
        let legacy = base.path().join("teamclaw").join("sessions");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("s1.toml"), b"id = 1").unwrap();

        migrate_rebrand_state_dir(base.path());

        assert_eq!(
            std::fs::read(base.path().join("teamclu/sessions/s1.toml")).unwrap(),
            b"id = 1"
        );
        assert!(!base.path().join("teamclaw").exists());
    }

    #[test]
    fn leaves_both_alone_when_destination_exists() {
        let base = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(base.path().join("teamclaw")).unwrap();
        std::fs::create_dir_all(base.path().join("teamclu")).unwrap();

        migrate_rebrand_state_dir(base.path());

        assert!(base.path().join("teamclaw").is_dir());
        assert!(base.path().join("teamclu").is_dir());
    }

    #[test]
    fn is_a_noop_without_a_legacy_dir() {
        let base = tempfile::tempdir().unwrap();
        migrate_rebrand_state_dir(base.path());
        assert!(!base.path().join("teamclu").exists());
    }
}
