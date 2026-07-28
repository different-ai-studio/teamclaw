//! One-shot migration: legacy official Dev paths (`teamclawdev`) → canonical `teamclaw`.
//!
//! White-label brands (`copilot361`, …) are untouched (Decision 2 = B).

use std::fs;
use std::path::{Path, PathBuf};

use teamclaw_runtime_env::{
    is_official_brand, LEGACY_OFFICIAL_DEV_CONFIG_FILE, LEGACY_OFFICIAL_DEV_STORAGE_DIR,
    OFFICIAL_STORAGE_DIR, STORAGE_NAMESPACE_MIGRATION_MARKER, WORKSPACE_CONFIG_FILE,
    WORKSPACE_META_DIR,
};

use super::APP_SHORT_NAME;

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

fn migration_marker_path(home: &Path) -> PathBuf {
    home.join(format!(".{OFFICIAL_STORAGE_DIR}"))
        .join("migrations")
        .join(STORAGE_NAMESPACE_MIGRATION_MARKER)
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
            let legacy_val: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&legacy_config).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            let mut base_val: serde_json::Value = fs::read_to_string(&canonical_config)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::json!({}));
            if let (Some(base), Some(overlay)) = (base_val.as_object_mut(), legacy_val.as_object()) {
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
    merge_tree(&legacy_dir.join("bm25_index"), &canonical_dir.join("bm25_index"))?;
    merge_tree(&legacy_dir.join("cron-runs"), &canonical_dir.join("cron-runs"))?;
    Ok(())
}

/// Migrate legacy official Dev storage into canonical `teamclaw` paths. Idempotent.
pub fn migrate_official_storage_namespace() {
    if !is_official_brand(APP_SHORT_NAME) {
        return;
    }
    let Some(home) = home_dir() else {
        return;
    };
    let marker = migration_marker_path(&home);
    if marker.is_file() {
        return;
    }

    if let Err(err) = migrate_home_storage(&home) {
        eprintln!("[storage_migration] home migration failed: {err}");
        return;
    }

    if let Err(err) = (|| {
        fs::create_dir_all(marker.parent().ok_or_else(|| "marker parent missing".to_string())?)
            .map_err(|e| e.to_string())?;
        fs::write(&marker, chrono::Utc::now().to_rfc3339()).map_err(|e| e.to_string())
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
            "team": {"sharedDirName": "teamclaw"}
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
}
