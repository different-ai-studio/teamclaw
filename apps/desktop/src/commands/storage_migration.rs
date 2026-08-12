//! One-shot migration: legacy official Dev paths (`teamcludev`) → canonical `teamclu`.
//!
//! White-label brands (`copilot361`, …) are untouched (Decision 2 = B).

use std::fs;
use std::path::{Path, PathBuf};

use teamclu_runtime_env::{
    is_official_brand, LEGACY_BRAND_CONFIG_FILE, LEGACY_BRAND_STORAGE_DIR,
    LEGACY_BRAND_TEAM_SHARED_DIR_NAME, LEGACY_BRAND_WORKSPACE_META_DIR,
    LEGACY_OFFICIAL_DEV_CONFIG_FILE, LEGACY_OFFICIAL_DEV_STORAGE_DIR, OFFICIAL_STORAGE_DIR,
    REBRAND_NAMESPACE_MIGRATION_MARKER, STORAGE_NAMESPACE_MIGRATION_MARKER, TEAM_SHARED_DIR_NAME,
    WORKSPACE_CONFIG_FILE, WORKSPACE_META_DIR,
};

use super::APP_SHORT_NAME;

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

fn migration_marker_path(home: &Path) -> PathBuf {
    marker_path(home, STORAGE_NAMESPACE_MIGRATION_MARKER)
}

fn marker_path(home: &Path, marker: &str) -> PathBuf {
    home.join(format!(".{OFFICIAL_STORAGE_DIR}"))
        .join("migrations")
        .join(marker)
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Move `src` onto `dst` wholesale, falling back to a content merge.
///
/// `rename` is the fast path and is what makes this a *move* rather than a copy —
/// the legacy directory stops existing, so nothing can later read half-migrated
/// state out of it. It only applies when `dst` is absent; when the user has
/// already launched a post-rebrand build (which creates `dst`), the two trees are
/// merged newest-wins and the legacy tree is deliberately left behind as a backup
/// rather than deleted.
fn move_tree(src: &Path, dst: &Path) -> Result<(), String> {
    if !dst.exists() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // EXDEV (src and dst on different filesystems) is the expected failure
        // here; both live under $HOME in practice, but a symlinked home would
        // split them. Merge instead of giving up.
        if fs::rename(src, dst).is_ok() {
            return Ok(());
        }
    }
    merge_tree(src, dst)
}

fn merge_json_objects(
    base: &mut serde_json::Map<String, serde_json::Value>,
    overlay: serde_json::Map<String, serde_json::Value>,
) {
    for (key, value) in overlay {
        match base.get_mut(&key) {
            Some(existing) if existing.is_object() && value.is_object() => {
                if let (Some(a), Some(b)) = (existing.as_object_mut(), value.as_object()) {
                    merge_json_objects(a, b.clone());
                }
            }
            Some(existing) if key == "envVars" && existing.is_array() && value.is_array() => {
                let mut keys = std::collections::HashSet::new();
                let mut merged = existing.as_array().cloned().unwrap_or_default();
                for entry in &merged {
                    if let Some(k) = entry.get("key").and_then(|v| v.as_str()) {
                        keys.insert(k.to_string());
                    }
                }
                for entry in value.as_array().into_iter().flatten() {
                    if let Some(k) = entry.get("key").and_then(|v| v.as_str()) {
                        if keys.insert(k.to_string()) {
                            merged.push(entry.clone());
                        }
                    }
                }
                *existing = serde_json::Value::Array(merged);
            }
            None => {
                base.insert(key, value);
            }
            _ => {}
        }
    }
}

fn copy_file_if_newer(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_file() {
        return Ok(());
    }
    if dst.exists() {
        let src_meta = fs::metadata(src).map_err(|e| e.to_string())?;
        let dst_meta = fs::metadata(dst).map_err(|e| e.to_string())?;
        if let (Ok(sm), Ok(dm)) = (src_meta.modified(), dst_meta.modified()) {
            if dm >= sm {
                return Ok(());
            }
        }
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(src, dst).map_err(|e| format!("copy {} → {}: {e}", src.display(), dst.display()))?;
    Ok(())
}

fn merge_tree(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    if src.is_file() {
        return copy_file_if_newer(src, dst);
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        merge_tree(&entry.path(), &dst.join(entry.file_name()))?;
    }
    Ok(())
}

fn migrate_home_storage(home: &Path) -> Result<(), String> {
    let legacy = home.join(format!(".{LEGACY_OFFICIAL_DEV_STORAGE_DIR}"));
    let canonical = home.join(format!(".{OFFICIAL_STORAGE_DIR}"));
    if !legacy.exists() {
        return Ok(());
    }

    merge_tree(&legacy.join("secrets"), &canonical.join("secrets"))?;
    for name in ["local-cache.db", "cached-path.txt", "env-blob.json"] {
        copy_file_if_newer(&legacy.join(name), &canonical.join(name))?;
    }
    Ok(())
}

fn migrate_workspace_meta(workspace: &Path) -> Result<(), String> {
    let legacy_dir = workspace.join(format!(".{LEGACY_OFFICIAL_DEV_STORAGE_DIR}"));
    let canonical_dir = workspace.join(WORKSPACE_META_DIR);
    if !legacy_dir.exists() {
        return Ok(());
    }

    fs::create_dir_all(&canonical_dir).map_err(|e| e.to_string())?;

    let legacy_config = legacy_dir.join(LEGACY_OFFICIAL_DEV_CONFIG_FILE);
    let canonical_config = canonical_dir.join(WORKSPACE_CONFIG_FILE);
    if legacy_config.is_file() {
        if canonical_config.is_file() {
            let legacy_val: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(&legacy_config).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let mut base_val: serde_json::Value = fs::read_to_string(&canonical_config)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::json!({}));
            if let (Some(base), Some(overlay)) = (base_val.as_object_mut(), legacy_val.as_object())
            {
                merge_json_objects(base, overlay.clone());
            }
            fs::write(
                &canonical_config,
                serde_json::to_string_pretty(&base_val).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        } else {
            fs::copy(&legacy_config, &canonical_config).map_err(|e| e.to_string())?;
        }
    }

    for name in [
        "knowledge.db",
        "rag-config.json",
        "stats.json",
        "cron-jobs.json",
        "sessions.json",
    ] {
        copy_file_if_newer(&legacy_dir.join(name), &canonical_dir.join(name))?;
    }
    merge_tree(
        &legacy_dir.join("bm25_index"),
        &canonical_dir.join("bm25_index"),
    )?;
    merge_tree(
        &legacy_dir.join("cron-runs"),
        &canonical_dir.join("cron-runs"),
    )?;
    Ok(())
}

/// Rebrand move: `~/.teamclaw` → `~/.teamclu`.
///
/// Unlike the dev→prod unification above this is a whole-namespace move, not a
/// copy of a known file list: the pre-rebrand directory holds the same layout
/// under a different name, and anything left behind (a provider cache, a new
/// sibling file added since) would simply be lost.
fn migrate_rebrand_home_storage(home: &Path) -> Result<(), String> {
    let legacy = home.join(format!(".{LEGACY_BRAND_STORAGE_DIR}"));
    if !legacy.is_dir() || is_symlink(&legacy) {
        return Ok(());
    }
    move_tree(&legacy, &home.join(format!(".{OFFICIAL_STORAGE_DIR}")))
}

/// Rebrand move for one workspace: `.teamclaw/` → `.teamclu/`, `teamclaw.json` →
/// `teamclu.json`, and the `teamclaw-team` team-drive symlink.
fn migrate_rebrand_workspace_meta(workspace: &Path) -> Result<(), String> {
    let legacy_dir = workspace.join(LEGACY_BRAND_WORKSPACE_META_DIR);
    let canonical_dir = workspace.join(WORKSPACE_META_DIR);
    if legacy_dir.is_dir() && !is_symlink(&legacy_dir) {
        move_tree(&legacy_dir, &canonical_dir)?;
    }

    // The config file is renamed too, so it arrives inside the canonical dir
    // still carrying its old name.
    let legacy_config = canonical_dir.join(LEGACY_BRAND_CONFIG_FILE);
    let canonical_config = canonical_dir.join(WORKSPACE_CONFIG_FILE);
    if legacy_config.is_file() && !canonical_config.exists() {
        fs::rename(&legacy_config, &canonical_config).map_err(|e| {
            format!(
                "rename {} → {}: {e}",
                legacy_config.display(),
                canonical_config.display()
            )
        })?;
    }

    // The team drive is a symlink into ~/.amuxd/teams/<id>/, so it is renamed
    // rather than copied — following it would duplicate the whole team tree into
    // the workspace. `exists()` follows symlinks and reports false for a dangling
    // one, which would then be clobbered; check the link itself.
    let legacy_link = workspace.join(LEGACY_BRAND_TEAM_SHARED_DIR_NAME);
    let canonical_link = workspace.join(TEAM_SHARED_DIR_NAME);
    if is_symlink(&legacy_link) && fs::symlink_metadata(&canonical_link).is_err() {
        fs::rename(&legacy_link, &canonical_link).map_err(|e| {
            format!(
                "rename {} → {}: {e}",
                legacy_link.display(),
                canonical_link.display()
            )
        })?;
    }
    Ok(())
}

/// Migrate legacy official Dev storage into canonical `teamclu` paths. Idempotent.
pub fn migrate_official_storage_namespace() {
    if !is_official_brand(APP_SHORT_NAME) {
        return;
    }
    let Some(home) = home_dir() else {
        return;
    };

    // Runs before the dev→prod pass: both merge into `~/.teamclu`, and doing the
    // rebrand move first lets it take the cheap whole-directory rename instead of
    // finding a target the dev pass has already created and falling back to a
    // file-by-file merge.
    let rebrand_marker = marker_path(&home, REBRAND_NAMESPACE_MIGRATION_MARKER);
    if !rebrand_marker.is_file() {
        match migrate_rebrand_home_storage(&home) {
            Ok(()) => write_marker(&rebrand_marker),
            Err(err) => eprintln!("[storage_migration] rebrand home migration failed: {err}"),
        }
    }

    let marker = migration_marker_path(&home);
    if marker.is_file() {
        return;
    }

    if let Err(err) = migrate_home_storage(&home) {
        eprintln!("[storage_migration] home migration failed: {err}");
        return;
    }

    write_marker(&marker);
}

fn write_marker(marker: &Path) {
    if let Err(err) = (|| {
        fs::create_dir_all(
            marker
                .parent()
                .ok_or_else(|| "marker parent missing".to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::write(marker, chrono::Utc::now().to_rfc3339()).map_err(|e| e.to_string())
    })() {
        eprintln!("[storage_migration] failed to write marker: {err}");
    }
}

/// Migrate a workspace directory when it is opened or registered.
pub fn migrate_workspace_storage_namespace(workspace_path: &str) {
    if !is_official_brand(APP_SHORT_NAME) {
        return;
    }
    let workspace = Path::new(workspace_path);
    // Rebrand first, for the same reason as the home pass: it can take the cheap
    // directory rename only while `.teamclu/` is still absent.
    if let Err(err) = migrate_rebrand_workspace_meta(workspace) {
        eprintln!(
            "[storage_migration] workspace {} rebrand migration failed: {err}",
            workspace.display()
        );
    }
    if let Err(err) = migrate_workspace_meta(workspace) {
        eprintln!(
            "[storage_migration] workspace {} migration failed: {err}",
            workspace.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_json_objects_unions_env_vars_by_key() {
        let mut base = serde_json::json!({
            "envVars": [{"key": "a", "description": "keep"}],
            "locale": "en"
        })
        .as_object()
        .unwrap()
        .clone();
        let overlay = serde_json::json!({
            "envVars": [{"key": "b", "description": "new"}],
            "team": {"sharedDirName": "teamclu"}
        })
        .as_object()
        .unwrap()
        .clone();
        merge_json_objects(&mut base, overlay);
        let env_vars = base.get("envVars").unwrap().as_array().unwrap();
        assert_eq!(env_vars.len(), 2);
        assert!(base.get("team").is_some());
        assert_eq!(base.get("locale").unwrap(), "en");
    }

    #[test]
    fn rebrand_home_moves_whole_namespace_when_target_absent() {
        let home = tempfile::tempdir().unwrap();
        let legacy = home.path().join(".teamclaw");
        fs::create_dir_all(legacy.join("secrets")).unwrap();
        fs::write(legacy.join("secrets/blob.bin"), b"sealed").unwrap();
        // A file the dev→prod pass does not know about: proof this is a move of
        // the whole tree rather than a copy of a hardcoded file list.
        fs::write(legacy.join("unlisted-sibling.json"), b"{}").unwrap();

        migrate_rebrand_home_storage(home.path()).unwrap();

        let canonical = home.path().join(".teamclu");
        assert_eq!(
            fs::read(canonical.join("secrets/blob.bin")).unwrap(),
            b"sealed"
        );
        assert!(canonical.join("unlisted-sibling.json").is_file());
        assert!(!legacy.exists(), "legacy dir should be gone after a move");
    }

    #[test]
    fn rebrand_home_merges_and_keeps_legacy_when_target_exists() {
        let home = tempfile::tempdir().unwrap();
        let legacy = home.path().join(".teamclaw");
        let canonical = home.path().join(".teamclu");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&canonical).unwrap();
        fs::write(legacy.join("only-in-legacy.txt"), b"carried").unwrap();

        migrate_rebrand_home_storage(home.path()).unwrap();

        assert_eq!(
            fs::read(canonical.join("only-in-legacy.txt")).unwrap(),
            b"carried"
        );
        assert!(
            legacy.exists(),
            "a merge must not delete the legacy tree — it is the only backup"
        );
    }

    // std::os::unix::fs::symlink has no portable equivalent; the migration itself
    // is cross-platform, only this fixture is not.
    #[cfg(unix)]
    #[test]
    fn rebrand_workspace_moves_meta_dir_config_and_team_link() {
        let ws = tempfile::tempdir().unwrap();
        let legacy_dir = ws.path().join(".teamclaw");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(legacy_dir.join("teamclaw.json"), br#"{"locale":"en"}"#).unwrap();
        fs::write(legacy_dir.join("knowledge.db"), b"idx").unwrap();

        let team_target = ws.path().join("team-global");
        fs::create_dir_all(&team_target).unwrap();
        std::os::unix::fs::symlink(&team_target, ws.path().join("teamclaw-team")).unwrap();

        migrate_rebrand_workspace_meta(ws.path()).unwrap();

        let canonical_dir = ws.path().join(".teamclu");
        assert_eq!(
            fs::read_to_string(canonical_dir.join("teamclu.json")).unwrap(),
            r#"{"locale":"en"}"#
        );
        assert!(!canonical_dir.join("teamclaw.json").exists());
        assert!(canonical_dir.join("knowledge.db").is_file());
        assert!(is_symlink(&ws.path().join("teamclu-team")));
        assert!(!is_symlink(&ws.path().join("teamclaw-team")));
    }

    #[test]
    fn rebrand_workspace_is_idempotent_and_noop_without_legacy() {
        let ws = tempfile::tempdir().unwrap();
        let canonical_dir = ws.path().join(".teamclu");
        fs::create_dir_all(&canonical_dir).unwrap();
        fs::write(canonical_dir.join("teamclu.json"), br#"{"locale":"zh"}"#).unwrap();

        migrate_rebrand_workspace_meta(ws.path()).unwrap();
        migrate_rebrand_workspace_meta(ws.path()).unwrap();

        assert_eq!(
            fs::read_to_string(canonical_dir.join("teamclu.json")).unwrap(),
            r#"{"locale":"zh"}"#
        );
    }

    /// This pass is for the official build only, and "official" is now exactly
    /// one name (ADR-0006). The pre-rebrand spellings deliberately no longer
    /// qualify: `.teamclaw` is both this migration's *source* directory and
    /// betly's own canonical metadata directory, so while betly counted as
    /// official it re-merged its own live config into `.teamclu/` on every
    /// workspace open — with `move_tree` keeping the legacy tree as a backup,
    /// forever, so the two copies just drifted.
    #[test]
    fn migration_runs_for_the_official_brand_only() {
        assert!(is_official_brand("teamclu"));

        assert!(!is_official_brand("teamclaw"));
        assert!(!is_official_brand("teamclawdev"));
        assert!(!is_official_brand("copilot361"));
    }
}
