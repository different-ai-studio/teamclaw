use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

use super::opencode::OpenCodeState;

/// Keyring service name prefix for all TeamClaw environment variables.
pub(crate) const KEYRING_SERVICE_PREFIX: &str = concat!(env!("APP_SHORT_NAME"), ".env");

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
    format!("{}/{}/{}", workspace_path, super::TEAMCLAW_DIR, super::CONFIG_FILE_NAME)
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
        .map_err(|e| format!("Failed to read teamclaw.json: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse teamclaw.json: {}", e))
}

/// Write the full teamclaw.json back (preserving all other fields).
fn write_teamclaw_json(workspace_path: &str, json: &serde_json::Value) -> Result<(), String> {
    let teamclaw_dir = format!("{}/{}", workspace_path, super::TEAMCLAW_DIR);
    let _ = std::fs::create_dir_all(&teamclaw_dir);
    let path = get_teamclaw_json_path(workspace_path);
    let content = serde_json::to_string_pretty(json)
        .map_err(|e| format!("Failed to serialize teamclaw.json: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write teamclaw.json: {}", e))
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
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
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

/// Resolve `${KEY}` references in a string by replacing them with actual values from the keyring.
#[tauri::command]
pub async fn env_var_resolve(input: String) -> Result<String, String> {
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
        let entry = keyring::Entry::new(&keyring_service(&key), "teamclaw")
            .map_err(|e| format!("Failed to create keyring entry for '{}': {}", key, e))?;
        match entry.get_password() {
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
