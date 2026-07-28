//! Canonical on-disk namespace for official TeamClaw builds vs white-label brands.
//!
//! Official Production + Dev share `~/.teamclaw` and `{workspace}/.teamclaw/`.
//! White-label builds keep `~/.{shortName}` / `{workspace}/.{shortName}/`.

/// Home + workspace storage dir name for official builds (`~/.teamclaw`).
pub const OFFICIAL_STORAGE_DIR: &str = "teamclaw";

/// Legacy official Dev dir name before namespace unification.
pub const LEGACY_OFFICIAL_DEV_STORAGE_DIR: &str = "teamclawdev";

/// Workspace metadata directory for official builds (`.teamclaw/`).
pub const WORKSPACE_META_DIR: &str = ".teamclaw";

/// Primary workspace config file for official builds.
pub const WORKSPACE_CONFIG_FILE: &str = "teamclaw.json";

/// Legacy Dev workspace config file name.
pub const LEGACY_OFFICIAL_DEV_CONFIG_FILE: &str = "teamclawdev.json";

/// One-shot migration marker under `~/.teamclaw/migrations/`.
pub const STORAGE_NAMESPACE_MIGRATION_MARKER: &str = "official-storage-namespace-v1";

/// Whether `short_name` identifies an official TeamClaw build (Prod or Dev).
pub fn is_official_brand(short_name: &str) -> bool {
    matches!(
        short_name,
        OFFICIAL_STORAGE_DIR | LEGACY_OFFICIAL_DEV_STORAGE_DIR
    )
}

/// Resolve the home-directory storage folder name (`teamclaw`, `copilot361`, …).
pub fn resolve_storage_dir_name(short_name: &str) -> &str {
    if is_official_brand(short_name) {
        OFFICIAL_STORAGE_DIR
    } else {
        short_name
    }
}

/// Legacy official Dev home dir (`teamclawdev`) when migrating an existing install.
pub fn legacy_official_home_dir_name(short_name: &str) -> Option<&'static str> {
    if short_name == LEGACY_OFFICIAL_DEV_STORAGE_DIR {
        Some(LEGACY_OFFICIAL_DEV_STORAGE_DIR)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_brands_share_teamclaw_storage() {
        assert!(is_official_brand("teamclaw"));
        assert!(is_official_brand("teamclawdev"));
        assert!(!is_official_brand("copilot361"));

        assert_eq!(resolve_storage_dir_name("teamclaw"), "teamclaw");
        assert_eq!(resolve_storage_dir_name("teamclawdev"), "teamclaw");
        assert_eq!(resolve_storage_dir_name("copilot361"), "copilot361");
    }
}
