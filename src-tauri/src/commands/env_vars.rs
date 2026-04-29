use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

use super::local_secret_store;
use super::opencode::OpenCodeState;

/// Single keychain entry that stores all env vars as a JSON blob.
pub(crate) const KEYRING_SERVICE: &str = concat!(env!("APP_SHORT_NAME"), ".env");
const LEGACY_MIGRATION_MARKER_KEY: &str = "_localPersonalSecretsMigrationComplete";

/// Disk-based fallback path for the env blob.
/// Used when keychain is inaccessible (e.g. after an unsigned app update
/// changes the binary signature and macOS revokes keychain access).
fn env_blob_fallback_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(concat!(".", env!("APP_SHORT_NAME"), "/env-blob.json")))
}

/// Read the env blob from the disk fallback file.
fn read_env_blob_from_disk() -> Option<serde_json::Map<String, serde_json::Value>> {
    let path = env_blob_fallback_path()?;
    let content = std::fs::read_to_string(&path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&content).ok()?;
    match val {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Write the env blob to the disk fallback file.
fn write_env_blob_to_disk(map: &serde_json::Map<String, serde_json::Value>) {
    if let Some(path) = env_blob_fallback_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json_str = match serde_json::to_string(map) {
            Ok(s) => s,
            Err(_) => return,
        };
        if let Err(e) = std::fs::write(&path, &json_str) {
            eprintln!("[EnvVars] Failed to write disk fallback: {}", e);
        }
    }
}

fn personal_secret_store_paths() -> Result<local_secret_store::SecretStorePaths, String> {
    local_secret_store::SecretStorePaths::for_home_dir()
}

pub(crate) fn read_legacy_keychain_blob(
    workspace_path: &str,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, "teamclaw")
        .map_err(|e| format!("Failed to open keychain entry: {}", e))?;

    match entry.get_password() {
        Ok(json_str) => {
            let val: serde_json::Value = serde_json::from_str(&json_str).unwrap_or_else(|e| {
                eprintln!(
                    "[EnvVars] Failed to parse keychain blob as JSON (corrupt?): {}",
                    e
                );
                serde_json::Value::Object(serde_json::Map::new())
            });
            match val {
                serde_json::Value::Object(map) => Ok(Some(map)),
                _ => Ok(Some(serde_json::Map::new())),
            }
        }
        Err(keyring::Error::NoEntry) => {
            let migrated = migrate_legacy_keyring(workspace_path);
            if !migrated.is_empty() {
                println!(
                    "[EnvVars] Migrated {} legacy keychain entries to local encrypted store",
                    migrated.len()
                );
                return Ok(Some(migrated));
            }
            if let Some(disk_blob) = read_env_blob_from_disk() {
                if !disk_blob.is_empty() {
                    println!(
                        "[EnvVars] Restored {} entries from legacy disk fallback",
                        disk_blob.len()
                    );
                    return Ok(Some(disk_blob));
                }
            }
            Ok(None)
        }
        Err(e) => {
            eprintln!(
                "[EnvVars] Legacy keychain read failed: {}. Trying disk fallback...",
                e
            );
            if let Some(disk_blob) = read_env_blob_from_disk() {
                if !disk_blob.is_empty() {
                    println!(
                        "[EnvVars] Restored {} entries from legacy disk fallback",
                        disk_blob.len()
                    );
                    return Ok(Some(disk_blob));
                }
            }
            Err(format!("Failed to read legacy keychain blob: {}", e))
        }
    }
}

fn read_personal_secret_blob(
    workspace_path: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let paths = personal_secret_store_paths()?;
    read_personal_secret_blob_from_paths(workspace_path, &paths)
}

pub(crate) fn read_personal_secret_blob_from_paths(
    workspace_path: &str,
    paths: &local_secret_store::SecretStorePaths,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    read_personal_secret_blob_with_reader(workspace_path, paths, read_legacy_keychain_blob)
}

pub(crate) fn read_personal_secret_blob_for_startup_from_paths(
    workspace_path: &str,
    paths: &local_secret_store::SecretStorePaths,
) -> Result<(serde_json::Map<String, serde_json::Value>, bool), String> {
    read_personal_secret_blob_with_reader_for_startup(
        workspace_path,
        paths,
        read_legacy_keychain_blob,
    )
}

fn read_personal_secret_blob_with_reader<F>(
    workspace_path: &str,
    paths: &local_secret_store::SecretStorePaths,
    legacy_reader: F,
) -> Result<serde_json::Map<String, serde_json::Value>, String>
where
    F: Fn(&str) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String>,
{
    read_personal_secret_blob_with_reader_for_startup(workspace_path, paths, legacy_reader)
        .map(|(blob, _retry_needed)| blob)
}

fn read_personal_secret_blob_with_reader_for_startup<F>(
    workspace_path: &str,
    paths: &local_secret_store::SecretStorePaths,
    legacy_reader: F,
) -> Result<(serde_json::Map<String, serde_json::Value>, bool), String>
where
    F: Fn(&str) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String>,
{
    if !paths.blob_path.exists() {
        let blob = local_secret_store::read_or_migrate_secret_blob(paths, || {
            legacy_reader(workspace_path)
        })?;
        if workspace_can_persist_legacy_migration_marker(workspace_path) {
            mark_workspace_legacy_migration_complete_best_effort(workspace_path);
        }
        return Ok((blob, false));
    }

    let mut blob = local_secret_store::read_secret_blob(paths)?;
    let mut top_up_succeeded = false;
    let mut retry_needed = false;
    let migration_pending = match workspace_legacy_migration_pending(workspace_path) {
        Ok(pending) => pending,
        Err(err) => {
            eprintln!(
                "[EnvVars] Legacy workspace top-up marker check failed for '{}': {}",
                workspace_path, err
            );
            retry_needed = true;
            false
        }
    };

    if migration_pending {
        match legacy_reader(workspace_path) {
            Ok(Some(legacy_map)) => {
                let mut changed = false;
                for (key, value) in legacy_map {
                    if let serde_json::map::Entry::Vacant(entry) = blob.entry(key) {
                        entry.insert(value);
                        changed = true;
                    }
                }
                if changed {
                    local_secret_store::write_secret_blob(paths, &blob)?;
                }
                top_up_succeeded = true;
            }
            Ok(None) => {
                top_up_succeeded = true;
            }
            Err(err) => {
                eprintln!(
                    "[EnvVars] Legacy workspace top-up skipped for '{}': {}",
                    workspace_path, err
                );
                retry_needed = true;
            }
        }
        if top_up_succeeded {
            mark_workspace_legacy_migration_complete_best_effort(workspace_path);
        }
    }

    Ok((blob, retry_needed))
}

fn write_personal_secret_blob(
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let paths = personal_secret_store_paths()?;
    local_secret_store::write_secret_blob(&paths, map)
}

/// Read the entire env var blob from the local encrypted personal secret store.
/// On first read, migrate legacy keychain or disk-snapshot data if present.
pub(crate) fn read_env_blob(
    workspace_path: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    read_personal_secret_blob(workspace_path)
}

/// Write the entire env var blob to the local encrypted personal secret store.
pub(crate) fn write_env_blob(
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    write_personal_secret_blob(map)
}

/// Snapshot legacy keychain data to the disk fallback file only when migration
/// has not yet produced a local encrypted blob. Called by the updater before
/// replacing the app bundle so pre-migration installs can still recover their
/// personal secrets after a signature-changing update.
pub(crate) fn snapshot_env_blob_to_disk() {
    let Ok(paths) = personal_secret_store_paths() else {
        return;
    };
    if paths.blob_path.exists() {
        return;
    }

    let entry = match keyring::Entry::new(KEYRING_SERVICE, "teamclaw") {
        Ok(e) => e,
        Err(_) => return,
    };
    if let Ok(json_str) = entry.get_password() {
        if let Ok(serde_json::Value::Object(map)) =
            serde_json::from_str::<serde_json::Value>(&json_str)
        {
            write_env_blob_to_disk(&map);
            println!(
                "[EnvVars] Snapshot {} keychain entries to disk before update",
                map.len()
            );
        }
    }
}

/// Read old per-key keychain entries and consolidate into a map.
/// Legacy entries are intentionally retained so migration can be retried safely
/// and additional workspaces can still top up the local encrypted store.
fn migrate_legacy_keyring(workspace_path: &str) -> serde_json::Map<String, serde_json::Value> {
    let path = format!("{}/{}/teamclaw.json", workspace_path, super::TEAMCLAW_DIR);
    let json: serde_json::Value = match std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
    {
        Some(v) => v,
        None => return serde_json::Map::new(),
    };

    let entries = match json.get("envVars").and_then(|v| v.as_array()) {
        Some(arr) => arr.clone(),
        None => return serde_json::Map::new(),
    };

    let mut map = serde_json::Map::new();
    for entry_val in &entries {
        let key = match entry_val.get("key").and_then(|k| k.as_str()) {
            Some(k) => k,
            None => continue,
        };
        // Legacy service name was `{KEYRING_SERVICE}.<KEY>`
        let legacy_service = format!("{}.{}", KEYRING_SERVICE, key);
        if let Ok(e) = keyring::Entry::new(&legacy_service, "teamclaw") {
            match e.get_password() {
                Ok(value) => {
                    map.insert(key.to_string(), serde_json::Value::String(value));
                }
                Err(e) => {
                    eprintln!(
                        "[EnvVars] Migration: failed to read legacy keychain entry '{}': {}",
                        key, e
                    );
                }
            }
        }
    }
    map
}

fn workspace_legacy_migration_pending(workspace_path: &str) -> Result<bool, String> {
    let json = read_teamclaw_json(workspace_path)?;
    Ok(!json
        .get(LEGACY_MIGRATION_MARKER_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

fn mark_workspace_legacy_migration_complete(workspace_path: &str) -> Result<(), String> {
    let mut json = read_teamclaw_json(workspace_path)?;
    if let Some(obj) = json.as_object_mut() {
        obj.insert(
            LEGACY_MIGRATION_MARKER_KEY.to_string(),
            serde_json::Value::Bool(true),
        );
        write_teamclaw_json(workspace_path, &json)?;
    }
    Ok(())
}

fn workspace_can_persist_legacy_migration_marker(workspace_path: &str) -> bool {
    let path = get_teamclaw_json_path(workspace_path);
    Path::new(&path).exists() && read_teamclaw_json(workspace_path).is_ok()
}

fn mark_workspace_legacy_migration_complete_best_effort(workspace_path: &str) {
    if let Err(err) = mark_workspace_legacy_migration_complete(workspace_path) {
        eprintln!(
            "[EnvVars] Failed to persist legacy workspace migration marker for '{}': {}",
            workspace_path, err
        );
    }
}

/// Context available to system env var default generators.
struct SystemEnvVarContext {
    device_id: String,
}

/// How a system env var's default value should be applied on startup.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DefaultPolicy {
    /// Re-derive on every startup; overwrite the stored value if it differs.
    /// Use when the default depends on system state that may change
    /// (e.g. `tc_api_key` is derived from `device_id`).
    RegenerateAlways,
    /// Write the default only when the key is missing from the blob.
    /// Empty user-set values are preserved (treated as "user has decided to leave blank").
    #[allow(dead_code)]
    SetIfAbsent,
}

/// Definition of a system-managed env var.
pub(crate) struct SystemEnvVarDef {
    key: &'static str,
    description: &'static str,
    default_fn: fn(&SystemEnvVarContext) -> Option<String>,
    policy: DefaultPolicy,
    /// When true, the entry is registered with category `system-shared`. The UI uses
    /// this to surface the key as a team-shared candidate (encrypted, synced via
    /// `shared_secrets`) and never seeds a value into the local keychain blob.
    shared_default: bool,
}

/// Registry of all system env vars.
/// To add a new one: append an entry here — nothing else changes.
pub(crate) const SYSTEM_ENV_VARS: &[SystemEnvVarDef] = &[SystemEnvVarDef {
    key: "tc_api_key",
    description: "Team LLM API Key",
    default_fn: |ctx| {
        if ctx.device_id.is_empty() {
            return None;
        }
        let id = &ctx.device_id;
        // 40 chars: matches the LiteLLM virtual key suffix length limit
        Some(format!("sk-tc-{}", &id[..id.len().min(40)]))
    },
    policy: DefaultPolicy::RegenerateAlways,
    shared_default: false,
}];

/// A single environment variable entry (key + description, no value).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVarEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>, // "system" | None
}

// ─── Internal helpers ───────────────────────────────────────────────────

/// Get the teamclaw.json path inside the workspace.
fn get_teamclaw_json_path(workspace_path: &str) -> String {
    format!(
        "{}/{}/{}",
        workspace_path,
        super::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME
    )
}

/// Read the envVars index from teamclaw.json (preserving all other fields).
pub(crate) fn read_teamclaw_json(workspace_path: &str) -> Result<serde_json::Value, String> {
    let path = get_teamclaw_json_path(workspace_path);
    if !Path::new(&path).exists() {
        return Ok(serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        }));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))
}

/// Write the full teamclaw.json back (preserving all other fields).
pub(crate) fn write_teamclaw_json(
    workspace_path: &str,
    json: &serde_json::Value,
) -> Result<(), String> {
    let teamclaw_dir = format!("{}/{}", workspace_path, super::TEAMCLAW_DIR);
    let _ = std::fs::create_dir_all(&teamclaw_dir);
    let path = get_teamclaw_json_path(workspace_path);
    let content = serde_json::to_string_pretty(json)
        .map_err(|e| format!("Failed to serialize {}: {}", super::CONFIG_FILE_NAME, e))?;
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
}

/// Read the envVars array from the JSON value.
fn get_env_vars_from_json(json: &serde_json::Value) -> Vec<EnvVarEntry> {
    json.get("envVars")
        .and_then(|v| serde_json::from_value::<Vec<EnvVarEntry>>(v.clone()).ok())
        .unwrap_or_default()
}

/// Write the envVars array back into the JSON value.
fn set_env_vars_in_json(json: &mut serde_json::Value, entries: &[EnvVarEntry]) {
    if let Some(obj) = json.as_object_mut() {
        if entries.is_empty() {
            obj.remove("envVars");
        } else {
            obj.insert(
                "envVars".to_string(),
                serde_json::to_value(entries).unwrap_or(serde_json::json!([])),
            );
        }
    }
}

/// Extract workspace_path from OpenCodeState (back-compat single-instance path).
fn get_workspace_path(state: &State<'_, OpenCodeState>) -> Result<String, String> {
    super::opencode::current_workspace_path(state)
}

// ─── Tauri Commands ─────────────────────────────────────────────────────

/// Store (or update) an environment variable in the local encrypted store and update the index in teamclaw.json.
#[tauri::command]
pub async fn env_var_set(
    state: State<'_, OpenCodeState>,
    key: String,
    value: String,
    description: Option<String>,
) -> Result<(), String> {
    let workspace_path = get_workspace_path(&state)?;

    // Read-modify-write atomically on a blocking thread
    let key_clone = key.clone();
    let value_clone = value.clone();
    let wp = workspace_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut blob = read_env_blob(&wp)?;
        blob.insert(key_clone, serde_json::Value::String(value_clone));
        write_env_blob(&blob)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Update index in teamclaw.json (metadata only, no value)
    let mut json = read_teamclaw_json(&workspace_path)?;
    let mut entries = get_env_vars_from_json(&json);

    if let Some(existing) = entries.iter_mut().find(|e| e.key == key) {
        existing.description = description;
    } else {
        entries.push(EnvVarEntry {
            key,
            description,
            category: None,
        });
    }

    set_env_vars_in_json(&mut json, &entries);
    write_teamclaw_json(&workspace_path, &json)
}

/// Retrieve an environment variable value from the local encrypted store.
#[tauri::command]
pub async fn env_var_get(state: State<'_, OpenCodeState>, key: String) -> Result<String, String> {
    let workspace_path = get_workspace_path(&state)?;
    let blob = tokio::task::spawn_blocking({
        let wp = workspace_path.clone();
        move || read_env_blob(&wp)
    })
    .await
    .map_err(|e| e.to_string())??;

    blob.get(&key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Key '{}' not found", key))
}

/// Delete an environment variable from both the local encrypted store and teamclaw.json index.
#[tauri::command]
pub async fn env_var_delete(state: State<'_, OpenCodeState>, key: String) -> Result<(), String> {
    let workspace_path = get_workspace_path(&state)?;

    // Read index once — used for both the guard check and the removal below.
    // Note: concurrent deletes from multiple Tauri windows could race here (each reads,
    // modifies, and writes the same json independently). In practice the settings UI is
    // single-user sequential, so this is acceptable.
    let mut json = read_teamclaw_json(&workspace_path)?;
    let mut entries = get_env_vars_from_json(&json);

    // Check category — system / system-shared vars cannot be deleted from the index
    // (they're auto-registered each launch by `ensure_system_env_vars`).
    if let Some(entry) = entries.iter().find(|e| e.key == key) {
        match entry.category.as_deref() {
            Some("system") | Some("system-shared") => {
                return Err(format!("System variable '{}' cannot be deleted", key));
            }
            _ => {}
        }
    }

    // Read-modify-write blob atomically on a blocking thread
    let key_clone = key.clone();
    let wp = workspace_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut blob = read_env_blob(&wp)?;
        blob.remove(&key_clone);
        write_env_blob(&blob)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Remove from teamclaw.json index (reuse the already-read json)
    entries.retain(|e| e.key != key);
    set_env_vars_in_json(&mut json, &entries);
    write_teamclaw_json(&workspace_path, &json)
}

/// List all registered environment variable keys with descriptions (no values).
#[tauri::command]
pub async fn env_var_list(state: State<'_, OpenCodeState>) -> Result<Vec<EnvVarEntry>, String> {
    let workspace_path = get_workspace_path(&state)?;
    let json = read_teamclaw_json(&workspace_path)?;
    Ok(get_env_vars_from_json(&json))
}

/// Resolve `${KEY}` references in a string by replacing them with actual values.
///
/// Resolution order for each `${KEY}`:
///   1. Shared secrets (team KMS, in-memory HashMap)
///   2. Local encrypted personal secret blob
///   3. System environment variables (`std::env::var`)
#[tauri::command]
pub async fn env_var_resolve(
    state: State<'_, OpenCodeState>,
    shared_secrets: State<'_, super::shared_secrets::SharedSecretsState>,
    input: String,
) -> Result<String, String> {
    let workspace_path = get_workspace_path(&state)?;
    let re = regex::Regex::new(r"\$\{([^}]+)\}").map_err(|e| format!("Invalid regex: {}", e))?;

    let mut result = input.clone();
    let mut errors: Vec<String> = Vec::new();

    let matches: Vec<(String, String)> = re
        .captures_iter(&input)
        .map(|cap| {
            let full_match = cap[0].to_string();
            let key = cap[1].to_string();
            (full_match, key)
        })
        .collect();

    // Read blob once upfront.
    let blob = {
        let wp = workspace_path.clone();
        tokio::task::spawn_blocking(move || read_env_blob(&wp))
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|e| {
                eprintln!("[EnvVars] env_var_resolve: failed to read personal secret blob, proceeding without local secrets: {}", e);
                serde_json::Map::new()
            })
    };

    for (full_match, key) in matches {
        // 1. Check shared secrets (team KMS) — try original key, then lowercase
        if let Some(value) =
            super::shared_secrets::get_secret_value(&shared_secrets, &key).or_else(|| {
                super::shared_secrets::get_secret_value(&shared_secrets, &key.to_lowercase())
            })
        {
            result = result.replace(&full_match, &value);
            continue;
        }

        // 2. Check local encrypted personal secret blob
        if let Some(value) = blob.get(&key).and_then(|v| v.as_str()) {
            result = result.replace(&full_match, value);
            continue;
        }

        // 3. Check system environment variables
        match std::env::var(&key) {
            Ok(value) => {
                result = result.replace(&full_match, &value);
            }
            Err(_) => {
                errors.push(key);
            }
        }
    }

    if !errors.is_empty() {
        return Err(format!(
            "Unresolved environment variable references: {}",
            errors.join(", ")
        ));
    }

    Ok(result)
}

/// Ensure all system env vars exist in the local encrypted store and in the teamclaw.json index.
/// If a key is missing from the blob, its default value is generated and written.
/// If a key already has a value (user customized), it is left unchanged.
/// This must be called on a blocking thread (disk I/O).
pub(crate) fn ensure_system_env_vars(workspace_path: &str, device_id: &str) -> Result<(), String> {
    let ctx = SystemEnvVarContext {
        device_id: device_id.to_string(),
    };
    let mut blob = read_env_blob(workspace_path)?;
    let mut json = read_teamclaw_json(workspace_path)?;
    let mut entries = get_env_vars_from_json(&json);
    let mut blob_changed = false;
    let mut index_changed = false;

    for def in SYSTEM_ENV_VARS {
        // `system-shared` defs never touch the local keychain blob — their values
        // live in `shared_secrets` (team KMS) and are injected into opencode at startup.
        // We only register them in the teamclaw.json index so the key shows up in
        // the env-var UI on every member's machine.
        if !def.shared_default {
            let key_present_in_blob = blob.contains_key(def.key);
            let existing_value = blob.get(def.key).and_then(|v| v.as_str()).unwrap_or("");

            match def.policy {
                DefaultPolicy::RegenerateAlways => {
                    // Re-derive on every startup; overwrite if the result differs.
                    // Used when the default depends on mutable system state (e.g. device_id).
                    if let Some(new_value) = (def.default_fn)(&ctx) {
                        if existing_value != new_value {
                            if !existing_value.is_empty() {
                                println!(
                                    "[EnvVars] Updating system var {} (value changed)",
                                    def.key
                                );
                            } else {
                                println!(
                                    "[EnvVars] Generated default value for system var: {}",
                                    def.key
                                );
                            }
                            blob.insert(def.key.to_string(), serde_json::Value::String(new_value));
                            blob_changed = true;
                        }
                    }
                }
                DefaultPolicy::SetIfAbsent => {
                    // Only seed the default when the key has never been written.
                    // An existing empty string is treated as "user left it blank intentionally".
                    if !key_present_in_blob {
                        if let Some(default) = (def.default_fn)(&ctx) {
                            println!("[EnvVars] Seeding system var {} with default", def.key);
                            blob.insert(def.key.to_string(), serde_json::Value::String(default));
                            blob_changed = true;
                        }
                    }
                }
            }
        }

        // Decide whether to register in the index (synced via teamclaw.json):
        //   - shared_default:                always register (key shows in UI; value lives in shared_secrets).
        //   - SetIfAbsent (local):           always register so the key shows even before a value is set.
        //   - RegenerateAlways (local):      only when the blob holds a non-empty value
        //                                    (skip when the generator yielded nothing, e.g. device_id not ready).
        let should_index = if def.shared_default {
            true
        } else {
            match def.policy {
                DefaultPolicy::RegenerateAlways => blob
                    .get(def.key)
                    .and_then(|v| v.as_str())
                    .map_or(false, |v| !v.is_empty()),
                DefaultPolicy::SetIfAbsent => true,
            }
        };
        if !should_index {
            continue;
        }

        let target_category = if def.shared_default {
            "system-shared"
        } else {
            "system"
        };
        if let Some(existing) = entries.iter_mut().find(|e| e.key == def.key) {
            if existing.category.as_deref() != Some(target_category) {
                existing.category = Some(target_category.to_string());
                index_changed = true;
            }
        } else {
            entries.push(EnvVarEntry {
                key: def.key.to_string(),
                description: Some(def.description.to_string()),
                category: Some(target_category.to_string()),
            });
            index_changed = true;
        }
    }

    if blob_changed {
        write_env_blob(&blob)?;
    }
    if index_changed {
        set_env_vars_in_json(&mut json, &entries);
        write_teamclaw_json(workspace_path, &json)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::local_secret_store::SecretStorePaths;
    use std::sync::{Mutex, OnceLock};
    use tempfile::tempdir;

    fn home_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct HomeGuard {
        original_home: Option<std::ffi::OsString>,
    }

    impl HomeGuard {
        fn set(path: &Path) -> Self {
            let original_home = std::env::var_os("HOME");
            std::env::set_var("HOME", path);
            Self { original_home }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.original_home {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[test]
    fn read_env_blob_migrates_legacy_disk_snapshot_into_local_encrypted_store() {
        let _home_guard = home_lock().lock().unwrap();
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let legacy_blob_dir = home_dir.path().join(concat!(".", env!("APP_SHORT_NAME")));
        std::fs::create_dir_all(&legacy_blob_dir).unwrap();

        let mut legacy_blob = serde_json::Map::new();
        legacy_blob.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("legacy-secret".into()),
        );
        std::fs::write(
            legacy_blob_dir.join("env-blob.json"),
            serde_json::to_vec(&legacy_blob).unwrap(),
        )
        .unwrap();

        let workspace_path = workspace_dir.path().to_string_lossy().to_string();
        let loaded = read_env_blob(&workspace_path).unwrap();
        assert_eq!(loaded, legacy_blob);

        let paths = SecretStorePaths::for_home_dir().unwrap();
        assert!(
            paths.blob_path.exists(),
            "expected encrypted blob to be created"
        );
        let meta = crate::commands::local_secret_store::read_meta(&paths).unwrap();
        assert!(meta.migrated_from_keychain);

        std::fs::remove_file(legacy_blob_dir.join("env-blob.json")).unwrap();

        let mut updated_blob = loaded.clone();
        updated_blob.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("local-secret".into()),
        );
        write_env_blob(&updated_blob).unwrap();

        let reloaded = read_env_blob(&workspace_path).unwrap();
        assert_eq!(
            reloaded.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("local-secret")
        );
    }

    #[test]
    fn read_personal_secret_blob_merges_legacy_once_per_workspace() {
        let _home_guard = home_lock().lock().unwrap();
        let home_dir = tempdir().unwrap();
        let workspace_a = tempdir().unwrap();
        let workspace_b = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let paths = SecretStorePaths::for_home_dir().unwrap();
        let workspace_a_path = workspace_a.path().to_string_lossy().to_string();
        let workspace_b_path = workspace_b.path().to_string_lossy().to_string();

        let first = read_personal_secret_blob_with_reader(&workspace_a_path, &paths, |wp| {
            let mut map = serde_json::Map::new();
            if wp == workspace_a_path {
                map.insert(
                    "WORKSPACE_A_KEY".into(),
                    serde_json::Value::String("a-secret".into()),
                );
            }
            Ok(Some(map))
        })
        .unwrap();
        assert_eq!(
            first.get("WORKSPACE_A_KEY").and_then(|v| v.as_str()),
            Some("a-secret")
        );

        let second = read_personal_secret_blob_with_reader(&workspace_b_path, &paths, |wp| {
            let mut map = serde_json::Map::new();
            if wp == workspace_b_path {
                map.insert(
                    "WORKSPACE_B_KEY".into(),
                    serde_json::Value::String("b-secret".into()),
                );
            }
            Ok(Some(map))
        })
        .unwrap();
        assert_eq!(
            second.get("WORKSPACE_A_KEY").and_then(|v| v.as_str()),
            Some("a-secret")
        );
        assert_eq!(
            second.get("WORKSPACE_B_KEY").and_then(|v| v.as_str()),
            Some("b-secret")
        );

        let third = read_personal_secret_blob_with_reader(&workspace_b_path, &paths, |_wp| {
            Err("legacy reader should not run after workspace migration".to_string())
        })
        .unwrap();
        assert_eq!(third, second);
    }

    #[test]
    fn existing_blob_survives_legacy_reader_error_without_marking_complete() {
        let _home_guard = home_lock().lock().unwrap();
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let paths = SecretStorePaths::for_home_dir().unwrap();
        let workspace_path = workspace_dir.path().to_string_lossy().to_string();

        let mut blob = serde_json::Map::new();
        blob.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("local-secret".into()),
        );
        local_secret_store::write_secret_blob(&paths, &blob).unwrap();

        let (first, retry_needed) =
            read_personal_secret_blob_with_reader_for_startup(&workspace_path, &paths, |_wp| {
                Err("simulated legacy reader failure".to_string())
            })
            .unwrap();
        assert_eq!(
            first.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("local-secret")
        );
        assert!(retry_needed);

        let second = read_personal_secret_blob_with_reader(&workspace_path, &paths, |_wp| {
            Err("legacy reader failure remains non-fatal on later reads".to_string())
        })
        .unwrap();
        assert_eq!(second, first);
    }

    #[test]
    fn existing_blob_reads_even_if_teamclaw_json_is_invalid() {
        let _home_guard = home_lock().lock().unwrap();
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let teamclaw_dir = workspace_dir.path().join(super::super::TEAMCLAW_DIR);
        std::fs::create_dir_all(&teamclaw_dir).unwrap();
        std::fs::write(teamclaw_dir.join(super::super::CONFIG_FILE_NAME), "{").unwrap();

        let paths = SecretStorePaths::for_home_dir().unwrap();
        let workspace_path = workspace_dir.path().to_string_lossy().to_string();

        let mut blob = serde_json::Map::new();
        blob.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("local-secret".into()),
        );
        local_secret_store::write_secret_blob(&paths, &blob).unwrap();

        let loaded = read_personal_secret_blob_with_reader(&workspace_path, &paths, |_wp| {
            Err("legacy reader should not be required when local blob already exists".into())
        })
        .unwrap();

        assert_eq!(
            loaded.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("local-secret")
        );
    }

    #[test]
    fn first_migration_succeeds_even_if_teamclaw_json_is_invalid() {
        let _home_guard = home_lock().lock().unwrap();
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let teamclaw_dir = workspace_dir.path().join(super::super::TEAMCLAW_DIR);
        std::fs::create_dir_all(&teamclaw_dir).unwrap();
        std::fs::write(teamclaw_dir.join(super::super::CONFIG_FILE_NAME), "{").unwrap();

        let workspace_path = workspace_dir.path().to_string_lossy().to_string();
        let loaded = read_env_blob(&workspace_path).unwrap();
        assert!(loaded.is_empty());

        let paths = SecretStorePaths::for_home_dir().unwrap();
        assert!(
            paths.blob_path.exists(),
            "expected encrypted blob to be created"
        );
    }

    #[test]
    fn startup_retry_is_requested_when_teamclaw_json_is_invalid() {
        let _home_guard = home_lock().lock().unwrap();
        let home_dir = tempdir().unwrap();
        let workspace_dir = tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        let teamclaw_dir = workspace_dir.path().join(super::super::TEAMCLAW_DIR);
        std::fs::create_dir_all(&teamclaw_dir).unwrap();
        std::fs::write(teamclaw_dir.join(super::super::CONFIG_FILE_NAME), "{").unwrap();

        let paths = SecretStorePaths::for_home_dir().unwrap();
        let workspace_path = workspace_dir.path().to_string_lossy().to_string();

        let mut blob = serde_json::Map::new();
        blob.insert(
            "OPENAI_API_KEY".into(),
            serde_json::Value::String("local-secret".into()),
        );
        local_secret_store::write_secret_blob(&paths, &blob).unwrap();

        let (loaded, retry_needed) =
            read_personal_secret_blob_with_reader_for_startup(&workspace_path, &paths, |_wp| {
                Ok(None)
            })
            .unwrap();

        assert_eq!(
            loaded.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("local-secret")
        );
        assert!(retry_needed);
    }
}
