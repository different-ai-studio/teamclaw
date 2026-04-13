//! Shared secrets manager — in-memory state, file I/O, and Tauri commands.
//!
//! Secrets are stored encrypted on disk under `<team_dir>/_secrets/<key_id>.enc.json`.
//! The in-memory HashMap is populated on init and kept in sync after each write/delete.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

use super::shared_secrets_crypto::{
    decrypt_secret, derive_key, encrypt_secret, EncryptedEnvelope, SecretEntry, SecretMeta,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const SECRETS_DIR: &str = "_secrets";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct SharedSecretsState {
    pub secrets: Mutex<HashMap<String, SecretEntry>>,
    pub derived_key: Mutex<Option<[u8; 32]>>,
    pub team_dir: Mutex<Option<PathBuf>>,
}

impl Default for SharedSecretsState {
    fn default() -> Self {
        Self {
            secrets: Mutex::new(HashMap::new()),
            derived_key: Mutex::new(None),
            team_dir: Mutex::new(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/// Validate that `key_id` is lowercase alphanumeric + underscores, 1–64 chars.
pub fn validate_key_id(key_id: &str) -> Result<(), String> {
    if key_id.is_empty() || key_id.len() > 64 {
        return Err(format!(
            "key_id must be 1–64 characters, got {}",
            key_id.len()
        ));
    }
    if !key_id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(format!(
            "key_id '{}' must contain only lowercase letters, digits, or underscores",
            key_id
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/// Returns the `_secrets/` directory inside `team_dir`, creating it if needed.
pub fn secrets_dir(team_dir: &Path) -> Result<PathBuf, String> {
    let dir = team_dir.join(SECRETS_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("secrets_dir: failed to create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Serialize and write an `EncryptedEnvelope` to `_secrets/<key_id>.enc.json`.
pub fn write_secret_file(
    team_dir: &Path,
    key_id: &str,
    envelope: &EncryptedEnvelope,
) -> Result<(), String> {
    let dir = secrets_dir(team_dir)?;
    let path = dir.join(format!("{}.enc.json", key_id));
    let content = serde_json::to_string_pretty(envelope)
        .map_err(|e| format!("write_secret_file: serialize: {e}"))?;
    std::fs::write(&path, content)
        .map_err(|e| format!("write_secret_file: write {}: {e}", path.display()))
}

/// Delete `_secrets/<key_id>.enc.json`. Missing file is treated as success.
pub fn delete_secret_file(team_dir: &Path, key_id: &str) -> Result<(), String> {
    let dir = secrets_dir(team_dir)?;
    let path = dir.join(format!("{}.enc.json", key_id));
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("delete_secret_file: remove {}: {e}", path.display()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Public functions (called from other modules, not Tauri commands)
// ---------------------------------------------------------------------------

/// Derive encryption key, persist `team_dir`, then load all secrets from disk.
pub fn init_shared_secrets(
    state: &SharedSecretsState,
    team_secret: &str,
    team_dir: &Path,
) -> Result<(), String> {
    let key = derive_key(team_secret)?;

    {
        let mut dk = state
            .derived_key
            .lock()
            .map_err(|e| format!("init_shared_secrets: lock derived_key: {e}"))?;
        *dk = Some(key);
    }
    {
        let mut td = state
            .team_dir
            .lock()
            .map_err(|e| format!("init_shared_secrets: lock team_dir: {e}"))?;
        *td = Some(team_dir.to_path_buf());
    }

    log::info!(
        "shared_secrets: initialized, team_dir={}",
        team_dir.display()
    );

    load_all_secrets(state)
}

/// Read all `_secrets/*.enc.json` files, decrypt, and populate the in-memory HashMap.
pub fn load_all_secrets(state: &SharedSecretsState) -> Result<(), String> {
    let team_dir = {
        let td = state
            .team_dir
            .lock()
            .map_err(|e| format!("load_all_secrets: lock team_dir: {e}"))?;
        td.clone()
            .ok_or_else(|| "load_all_secrets: team_dir not set".to_string())?
    };
    let derived_key = {
        let dk = state
            .derived_key
            .lock()
            .map_err(|e| format!("load_all_secrets: lock derived_key: {e}"))?;
        dk.ok_or_else(|| "load_all_secrets: derived_key not set".to_string())?
    };

    let dir = secrets_dir(&team_dir)?;

    let mut new_map: HashMap<String, SecretEntry> = HashMap::new();

    let read_dir = std::fs::read_dir(&dir)
        .map_err(|e| format!("load_all_secrets: read_dir {}: {e}", dir.display()))?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("shared_secrets: skipping unreadable dir entry: {e}");
                continue;
            }
        };

        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();

        if !file_name.ends_with(".enc.json") {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!(
                    "shared_secrets: skipping unreadable file {}: {e}",
                    path.display()
                );
                continue;
            }
        };

        let envelope: EncryptedEnvelope = match serde_json::from_str(&content) {
            Ok(env) => env,
            Err(e) => {
                log::warn!(
                    "shared_secrets: skipping malformed envelope {}: {e}",
                    path.display()
                );
                continue;
            }
        };

        match decrypt_secret(&envelope, &derived_key) {
            Ok(secret) => {
                log::info!("shared_secrets: loaded secret '{}'", secret.key_id);
                new_map.insert(secret.key_id.clone(), secret);
            }
            Err(e) => {
                log::warn!("shared_secrets: failed to decrypt {}: {e}", path.display());
            }
        }
    }

    let mut secrets = state
        .secrets
        .lock()
        .map_err(|e| format!("load_all_secrets: lock secrets: {e}"))?;
    *secrets = new_map;
    log::info!("shared_secrets: loaded {} secret(s)", secrets.len());
    Ok(())
}

/// Look up a secret value from the in-memory HashMap (internal use only).
pub fn get_secret_value(state: &SharedSecretsState, key_id: &str) -> Option<String> {
    let secrets = state.secrets.lock().ok()?;
    secrets.get(key_id).map(|e| e.key.clone())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Create or update a shared secret: encrypt and write to disk, update HashMap.
#[tauri::command]
pub async fn shared_secret_set(
    app_handle: AppHandle,
    state: State<'_, SharedSecretsState>,
    key_id: String,
    value: String,
    description: String,
    category: String,
    node_id: String,
) -> Result<(), String> {
    validate_key_id(&key_id)?;

    let team_dir = {
        let td = state
            .team_dir
            .lock()
            .map_err(|e| format!("shared_secret_set: lock team_dir: {e}"))?;
        td.clone()
            .ok_or_else(|| "shared_secret_set: secrets not initialized".to_string())?
    };
    let derived_key = {
        let dk = state
            .derived_key
            .lock()
            .map_err(|e| format!("shared_secret_set: lock derived_key: {e}"))?;
        dk.ok_or_else(|| "shared_secret_set: derived_key not set".to_string())?
    };

    // Preserve created_by from existing entry on update; set to caller on create
    let created_by = {
        let secrets = state
            .secrets
            .lock()
            .map_err(|e| format!("shared_secret_set: lock secrets: {e}"))?;
        secrets
            .get(&key_id)
            .map(|e| e.created_by.clone())
            .unwrap_or_else(|| node_id.clone())
    };

    let now = chrono::Utc::now().to_rfc3339();
    let entry = SecretEntry {
        key_id: key_id.clone(),
        key: value,
        description,
        category,
        created_by,
        updated_by: node_id,
        updated_at: now,
    };

    let envelope = encrypt_secret(&entry, &derived_key)?;
    write_secret_file(&team_dir, &key_id, &envelope)?;

    {
        let mut secrets = state
            .secrets
            .lock()
            .map_err(|e| format!("shared_secret_set: lock secrets: {e}"))?;
        secrets.insert(key_id.clone(), entry);
    }

    app_handle.emit("secrets-changed", ()).ok();
    log::info!("shared_secrets: set secret '{}'", key_id);
    Ok(())
}

/// Delete a shared secret: only the team Owner or the secret's creator can delete.
#[tauri::command]
pub async fn shared_secret_delete(
    app_handle: AppHandle,
    state: State<'_, SharedSecretsState>,
    key_id: String,
    node_id: String,
    role: String,
) -> Result<(), String> {
    validate_key_id(&key_id)?;

    // Check permission: Owner can delete any; others can only delete their own
    {
        let secrets = state
            .secrets
            .lock()
            .map_err(|e| format!("shared_secret_delete: lock secrets: {e}"))?;
        if let Some(entry) = secrets.get(&key_id) {
            let is_owner = role == "owner";
            let is_creator = entry.created_by == node_id;
            if !is_owner && !is_creator {
                return Err("Permission denied: only the team owner or the secret creator can delete this secret".to_string());
            }
        }
    }

    let team_dir = {
        let td = state
            .team_dir
            .lock()
            .map_err(|e| format!("shared_secret_delete: lock team_dir: {e}"))?;
        td.clone()
            .ok_or_else(|| "shared_secret_delete: secrets not initialized".to_string())?
    };

    delete_secret_file(&team_dir, &key_id)?;

    {
        let mut secrets = state
            .secrets
            .lock()
            .map_err(|e| format!("shared_secret_delete: lock secrets: {e}"))?;
        secrets.remove(&key_id);
    }

    app_handle.emit("secrets-changed", ()).ok();
    log::info!("shared_secrets: deleted secret '{}'", key_id);
    Ok(())
}

/// List all secrets as metadata (no plaintext values), sorted by key_id.
#[tauri::command]
pub async fn shared_secret_list(
    state: State<'_, SharedSecretsState>,
) -> Result<Vec<SecretMeta>, String> {
    let secrets = state
        .secrets
        .lock()
        .map_err(|e| format!("shared_secret_list: lock secrets: {e}"))?;

    let mut list: Vec<SecretMeta> = secrets.values().map(SecretMeta::from).collect();
    list.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    Ok(list)
}
