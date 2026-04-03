use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

use super::opencode::OpenCodeState;

/// Keyring service name prefix for all TeamClaw environment variables.
pub(crate) const KEYRING_SERVICE_PREFIX: &str = concat!(env!("APP_SHORT_NAME"), ".env");

/// Single keychain entry that stores all env vars as a JSON blob.
pub(crate) const KEYRING_SERVICE: &str = concat!(env!("APP_SHORT_NAME"), ".env");

/// Legacy per-key service prefix (used only for migration detection).
const LEGACY_SERVICE_PREFIX: &str = concat!(env!("APP_SHORT_NAME"), ".env");

/// Read the entire env var blob from keychain.
/// Returns an empty map if the entry doesn't exist yet.
/// On first call after migration: detects old per-key entries and consolidates them.
pub(crate) fn read_env_blob(workspace_path: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, "teamclaw")
        .map_err(|e| format!("Failed to open keychain entry: {}", e))?;

    match entry.get_password() {
        Ok(json_str) => {
            let val: serde_json::Value = serde_json::from_str(&json_str)
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
            match val {
                serde_json::Value::Object(map) => Ok(map),
                _ => Ok(serde_json::Map::new()),
            }
        }
        Err(keyring::Error::NoEntry) => {
            // First launch: attempt migration from legacy per-key format
            let migrated = migrate_legacy_keyring(workspace_path);
            if !migrated.is_empty() {
                println!("[EnvVars] Migrated {} legacy keychain entries to blob", migrated.len());
                write_env_blob(&migrated)?;
            }
            Ok(migrated)
        }
        Err(e) => Err(format!("Failed to read keychain blob: {}", e)),
    }
}

/// Write the entire env var blob to keychain.
pub(crate) fn write_env_blob(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let json_str = serde_json::to_string(map)
        .map_err(|e| format!("Failed to serialize env blob: {}", e))?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, "teamclaw")
        .map_err(|e| format!("Failed to open keychain entry: {}", e))?;
    entry.set_password(&json_str)
        .map_err(|e| format!("Failed to write keychain blob: {}", e))
}

/// Read old per-key keychain entries and consolidate into a map.
/// Deletes old entries after reading.
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
        // Legacy service name was "teamclaw.env.<KEY>"
        let legacy_service = format!("{}.{}", LEGACY_SERVICE_PREFIX, key);
        if let Ok(e) = keyring::Entry::new(&legacy_service, "teamclaw") {
            if let Ok(value) = e.get_password() {
                map.insert(key.to_string(), serde_json::Value::String(value));
                // Delete old entry
                let _ = e.delete_credential();
            }
        }
    }
    map
}

/// A single environment variable entry (key + description, no value).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVarEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

// ─── Internal helpers ───────────────────────────────────────────────────

/// Build the keyring service name for a given key.
pub(crate) fn keyring_service(key: &str) -> String {
    format!("{}.{}", KEYRING_SERVICE_PREFIX, key)
}

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
fn read_teamclaw_json(workspace_path: &str) -> Result<serde_json::Value, String> {
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
fn write_teamclaw_json(workspace_path: &str, json: &serde_json::Value) -> Result<(), String> {
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

/// Extract workspace_path from OpenCodeState.
fn get_workspace_path(state: &State<'_, OpenCodeState>) -> Result<String, String> {
    state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())
}

// ─── Tauri Commands ─────────────────────────────────────────────────────

/// Store (or update) an environment variable in the OS keyring and update the index in teamclaw.json.
#[tauri::command]
pub async fn env_var_set(
    state: State<'_, OpenCodeState>,
    key: String,
    value: String,
    description: Option<String>,
) -> Result<(), String> {
    let workspace_path = get_workspace_path(&state)?;

    // Store value in OS keyring
    let entry = keyring::Entry::new(&keyring_service(&key), "teamclaw")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    entry
        .set_password(&value)
        .map_err(|e| format!("Failed to store secret in keyring: {}", e))?;

    // Update index in teamclaw.json
    let mut json = read_teamclaw_json(&workspace_path)?;
    let mut entries = get_env_vars_from_json(&json);

    if let Some(existing) = entries.iter_mut().find(|e| e.key == key) {
        // Update description if changed
        existing.description = description;
    } else {
        // Add new entry
        entries.push(EnvVarEntry { key, description });
    }

    set_env_vars_in_json(&mut json, &entries);
    write_teamclaw_json(&workspace_path, &json)
}

/// Retrieve an environment variable value from the OS keyring.
#[tauri::command]
pub async fn env_var_get(key: String) -> Result<String, String> {
    let entry = keyring::Entry::new(&keyring_service(&key), "teamclaw")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    entry
        .get_password()
        .map_err(|e| format!("Key '{}' not found in keyring: {}", key, e))
}

/// Delete an environment variable from both the OS keyring and teamclaw.json index.
#[tauri::command]
pub async fn env_var_delete(state: State<'_, OpenCodeState>, key: String) -> Result<(), String> {
    let workspace_path = get_workspace_path(&state)?;

    // Delete from OS keyring (ignore errors if not found)
    let entry = keyring::Entry::new(&keyring_service(&key), "teamclaw")
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    let _ = entry.delete_credential();

    // Remove from teamclaw.json index
    let mut json = read_teamclaw_json(&workspace_path)?;
    let mut entries = get_env_vars_from_json(&json);
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
///   2. Local keyring (per-user OS keyring)
///   3. System environment variables (`std::env::var`)
#[tauri::command]
pub async fn env_var_resolve(
    shared_secrets: State<'_, super::shared_secrets::SharedSecretsState>,
    input: String,
) -> Result<String, String> {
    let re = regex::Regex::new(r"\$\{([^}]+)\}").map_err(|e| format!("Invalid regex: {}", e))?;

    let mut result = input.clone();
    let mut errors: Vec<String> = Vec::new();

    // Collect all matches first to avoid borrow issues
    let matches: Vec<(String, String)> = re
        .captures_iter(&input)
        .map(|cap| {
            let full_match = cap[0].to_string();
            let key = cap[1].to_string();
            (full_match, key)
        })
        .collect();

    for (full_match, key) in matches {
        // 1. Check shared secrets (team KMS) — try original key, then lowercase
        if let Some(value) =
            super::shared_secrets::get_secret_value(&shared_secrets, &key)
                .or_else(|| super::shared_secrets::get_secret_value(&shared_secrets, &key.to_lowercase()))
        {
            result = result.replace(&full_match, &value);
            continue;
        }

        // 2. Check local keyring
        let entry = keyring::Entry::new(&keyring_service(&key), "teamclaw")
            .map_err(|e| format!("Failed to create keyring entry for '{}': {}", key, e))?;
        match entry.get_password() {
            Ok(value) => {
                result = result.replace(&full_match, &value);
                continue;
            }
            Err(_) => {}
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
