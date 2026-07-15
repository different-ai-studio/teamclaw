use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tracing::info;

use crate::APP_SECRETS_DIR;

const MIN_DB_BYTES: u64 = 4096;
const MIGRATION_MARKER_NAME: &str = "opencode-global-db-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationResult {
    pub migrated: bool,
}

/// Global OpenCode SQLite DB: `~/.local/share/opencode/opencode.db`.
fn global_opencode_db_path(home: &Path) -> PathBuf {
    home.join(".local/share/opencode/opencode.db")
}

/// Legacy per-workspace isolated DB from the old XDG-redirect layout.
fn isolated_opencode_db_path(workspace: &Path) -> PathBuf {
    workspace.join(".opencode/data/opencode/opencode.db")
}

/// One-shot migration marker: `~/.teamclaw/migrations/opencode-global-db-v1`.
fn migration_marker_path(home: &Path) -> PathBuf {
    home.join(format!(".{APP_SECRETS_DIR}/migrations/{MIGRATION_MARKER_NAME}"))
}

fn file_len(path: &Path) -> anyhow::Result<Option<u64>> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(Some(meta.len())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn unix_timestamp_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Migrate a legacy workspace-isolated OpenCode DB into the global location when
/// the global DB is missing or empty and a substantial isolated copy exists.
pub fn maybe_migrate_legacy_opencode_db(
    workspace: &Path,
) -> anyhow::Result<Option<MigrationResult>> {
    let Some(home) = dirs::home_dir() else {
        return Ok(None);
    };

    let marker = migration_marker_path(&home);
    if marker.exists() {
        return Ok(None);
    }

    let global_db = global_opencode_db_path(&home);
    let isolated_db = isolated_opencode_db_path(workspace);

    let global_len = file_len(&global_db)?;
    let isolated_len = file_len(&isolated_db)?;

    let global_is_candidate = global_len.is_none()
        || global_len.is_some_and(|len| len < MIN_DB_BYTES);
    let isolated_is_candidate =
        isolated_len.is_some_and(|len| len >= MIN_DB_BYTES);

    if !(global_is_candidate && isolated_is_candidate) {
        return Ok(None);
    }

    if let Some(parent) = global_db.parent() {
        std::fs::create_dir_all(parent)?;
    }

    if global_db.exists() {
        let backup = global_db.with_file_name(format!(
            "opencode.db.bak.{}",
            unix_timestamp_secs()
        ));
        std::fs::copy(&global_db, &backup)?;
        info!(
            from = %global_db.display(),
            backup = %backup.display(),
            "Backed up existing global OpenCode DB before legacy migration"
        );
    }

    std::fs::copy(&isolated_db, &global_db)?;

    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&marker, b"")?;

    info!(
        workspace = %workspace.display(),
        from = %isolated_db.display(),
        to = %global_db.display(),
        "Migrated legacy isolated OpenCode DB to global location"
    );

    Ok(Some(MigrationResult { migrated: true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{home_env_lock, HomeGuard};
    use tempfile::tempdir;

    fn write_isolated_db(workspace: &Path, size: usize) {
        let path = isolated_opencode_db_path(workspace);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, vec![b'x'; size]).unwrap();
    }

    #[test]
    fn migration_runs_when_global_missing_and_isolated_large() {
        let _lock = home_env_lock();
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        write_isolated_db(workspace_dir.path(), MIN_DB_BYTES as usize);

        let result = maybe_migrate_legacy_opencode_db(workspace_dir.path()).unwrap();
        assert_eq!(result, Some(MigrationResult { migrated: true }));

        let global_db = global_opencode_db_path(home_dir.path());
        assert!(global_db.exists());
        assert_eq!(
            std::fs::metadata(&global_db).unwrap().len(),
            MIN_DB_BYTES
        );
        assert!(migration_marker_path(home_dir.path()).exists());
    }

    #[test]
    fn migration_skipped_when_marker_exists() {
        let _lock = home_env_lock();
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let marker = migration_marker_path(home_dir.path());
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, b"").unwrap();

        write_isolated_db(workspace_dir.path(), MIN_DB_BYTES as usize);

        let result = maybe_migrate_legacy_opencode_db(workspace_dir.path()).unwrap();
        assert_eq!(result, None);
        assert!(!global_opencode_db_path(home_dir.path()).exists());
    }

    #[test]
    fn migration_skipped_when_isolated_too_small() {
        let _lock = home_env_lock();
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        write_isolated_db(workspace_dir.path(), (MIN_DB_BYTES - 1) as usize);

        let result = maybe_migrate_legacy_opencode_db(workspace_dir.path()).unwrap();
        assert_eq!(result, None);
        assert!(!global_opencode_db_path(home_dir.path()).exists());
        assert!(!migration_marker_path(home_dir.path()).exists());
    }
}
