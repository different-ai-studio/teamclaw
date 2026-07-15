//! Shared secrets — team env var storage under `<team_dir>/_secrets/*.enc.json`.
//!
//! Writes are routed through `env_catalog_set` / `env_catalog_delete`; this module
//! owns encryption, in-memory cache, and lazy init from workspace config.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

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

/// Returns the `_secrets/` directory inside an existing `team_dir`, creating the
/// subdirectory if needed.
pub fn secrets_dir(team_dir: &Path) -> Result<PathBuf, String> {
    if !team_dir.exists() {
        return Err(format!(
            "secrets_dir: team dir does not exist: {}",
            team_dir.display()
        ));
    }
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

    let dir = team_dir.join(SECRETS_DIR);

    if !dir.exists() {
        let mut secrets = state
            .secrets
            .lock()
            .map_err(|e| format!("load_all_secrets: lock secrets: {e}"))?;
        secrets.clear();
        log::info!(
            "shared_secrets: no secrets directory at {}, treating as empty",
            dir.display()
        );
        return Ok(());
    }

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

/// Try to initialize shared_secrets from the workspace's team config.
/// Supports configured shared Git directories.
/// Fast-path returns Ok() immediately when already initialized.
///
/// Called before team writes so a user who joined a team but hasn't opened
/// the Team settings panel can still save shared secrets.
///
/// `team_id`, when provided, lets `resolve_team_env_secret` fall back to the
/// locally-stored `_team_secret.{team_id}` blob when the workspace's
/// `teamclaw.json` does not carry an inline `team.envSecret`. Without it, a user
/// who joined a team whose config lacks the inline secret would fail to
/// initialize even though the secret is present in the personal secret store.
/// Resolve the directory team secrets should be written to for this workspace.
///
/// Preferred: the workspace's `teamclaw-team` entry — a symlink into the
/// daemon's single global copy. But daemon-owned session workspaces
/// (`~/.amuxd/apps/<app_id>`) frequently have no such link, so resolving the
/// team dir purely relative to the workspace yields a non-existent path and the
/// write fails with `secrets_dir: team dir does not exist`.
///
/// When the workspace link is absent and we know the `team_id`, fall back to the
/// daemon's global team dir `~/.amuxd/teams/<team_id>/teamclaw-team` — the single
/// real copy where team secrets belong — creating it if the daemon has not
/// scaffolded it yet so the first team-secret write can land. The workspace
/// symlink path itself is never created here: a missing link there means the
/// team isn't linked into that workspace, which `secrets_dir()` should surface.
fn resolve_team_dir(workspace: &Path, team_id: Option<&str>) -> Result<PathBuf, String> {
    let workspace_team_dir =
        teamclaw_runtime_env::env_catalog::resolve_team_dir_for_workspace(workspace);
    if workspace_team_dir.exists() {
        return Ok(workspace_team_dir);
    }
    let Some(global) = team_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .and_then(super::team_share::enable::global_team_dir_display)
    else {
        return Ok(workspace_team_dir);
    };
    let global = PathBuf::from(global);
    std::fs::create_dir_all(&global).map_err(|e| {
        format!(
            "resolve_team_dir: failed to create global team dir {}: {e}",
            global.display()
        )
    })?;
    Ok(global)
}

pub fn try_lazy_init_from_workspace(
    state: &SharedSecretsState,
    workspace_path: &str,
    team_id: Option<&str>,
) -> Result<(), String> {
    let workspace = Path::new(workspace_path);
    if !teamclaw_config_path(workspace).exists() {
        return Err("No team configured for this workspace".to_string());
    }
    let env_secret = teamclaw_runtime_env::env_catalog::resolve_team_env_secret(workspace, team_id)
        .ok_or_else(|| {
            "Team shared environment variables are not initialized for this workspace".to_string()
        })?;
    let team_dir = resolve_team_dir(workspace, team_id)?;
    let derived_key = derive_key(&env_secret)?;

    {
        let current_team_dir = state
            .team_dir
            .lock()
            .map_err(|e| format!("try_lazy_init: lock team_dir: {e}"))?
            .clone();
        let current_key = *state
            .derived_key
            .lock()
            .map_err(|e| format!("try_lazy_init: lock derived_key: {e}"))?;
        if current_team_dir.as_ref() == Some(&team_dir) && current_key == Some(derived_key) {
            return Ok(());
        }
    }

    init_shared_secrets(state, &env_secret, &team_dir)
}

fn teamclaw_config_path(workspace: &Path) -> PathBuf {
    workspace
        .join(super::TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME)
}

// ---------------------------------------------------------------------------
// Internal write helpers (used by env_catalog commands)
// ---------------------------------------------------------------------------

pub(crate) async fn set_secret_for_workspace(
    app_handle: &AppHandle,
    state: &SharedSecretsState,
    workspace_path: &str,
    key_id: String,
    value: String,
    description: String,
    category: String,
    node_id: String,
    team_id: Option<String>,
) -> Result<(), String> {
    validate_key_id(&key_id)?;
    try_lazy_init_from_workspace(state, workspace_path, team_id.as_deref())?;

    let team_dir = {
        let td = state
            .team_dir
            .lock()
            .map_err(|e| format!("set_secret_for_workspace: lock team_dir: {e}"))?;
        td.clone()
            .ok_or_else(|| "set_secret_for_workspace: secrets not initialized".to_string())?
    };
    let derived_key = {
        let dk = state
            .derived_key
            .lock()
            .map_err(|e| format!("set_secret_for_workspace: lock derived_key: {e}"))?;
        dk.ok_or_else(|| "set_secret_for_workspace: derived_key not set".to_string())?
    };

    let created_by = {
        let secrets = state
            .secrets
            .lock()
            .map_err(|e| format!("set_secret_for_workspace: lock secrets: {e}"))?;
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
            .map_err(|e| format!("set_secret_for_workspace: lock secrets: {e}"))?;
        secrets.insert(key_id.clone(), entry);
    }

    app_handle.emit("secrets-changed", ()).ok();
    log::info!("shared_secrets: set secret '{}'", key_id);
    Ok(())
}

pub(crate) async fn delete_secret_for_workspace(
    app_handle: &AppHandle,
    state: &SharedSecretsState,
    workspace_path: &str,
    key_id: String,
    node_id: String,
    role: String,
    team_id: Option<String>,
) -> Result<(), String> {
    validate_key_id(&key_id)?;
    try_lazy_init_from_workspace(state, workspace_path, team_id.as_deref())?;

    {
        let secrets = state
            .secrets
            .lock()
            .map_err(|e| format!("delete_secret_for_workspace: lock secrets: {e}"))?;
        if let Some(entry) = secrets.get(&key_id) {
            let is_owner = role == "owner";
            let is_creator = entry.created_by == node_id;
            if !is_owner && !is_creator {
                return Err(
                    "Permission denied: only the team owner or the secret creator can delete this secret"
                        .to_string(),
                );
            }
        }
    }

    let team_dir = {
        let td = state
            .team_dir
            .lock()
            .map_err(|e| format!("delete_secret_for_workspace: lock team_dir: {e}"))?;
        td.clone()
            .ok_or_else(|| "delete_secret_for_workspace: secrets not initialized".to_string())?
    };

    delete_secret_file(&team_dir, &key_id)?;

    {
        let mut secrets = state
            .secrets
            .lock()
            .map_err(|e| format!("delete_secret_for_workspace: lock secrets: {e}"))?;
        secrets.remove(&key_id);
    }

    app_handle.emit("secrets-changed", ()).ok();
    log::info!("shared_secrets: deleted secret '{}'", key_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_shared_secrets_does_not_create_missing_team_dir() {
        let workspace_dir = tempfile::tempdir().unwrap();
        let team_dir = workspace_dir.path().join("teamclaw");
        let state = SharedSecretsState::default();
        let team_secret = "00".repeat(32);

        let result = init_shared_secrets(&state, &team_secret, &team_dir);

        assert!(result.is_ok());
        assert!(!team_dir.exists());
    }

    fn home_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    struct HomeGuard {
        original: Option<std::ffi::OsString>,
    }

    impl HomeGuard {
        fn set(path: &Path) -> Self {
            let original = std::env::var_os("HOME");
            std::env::set_var("HOME", path);
            Self { original }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[test]
    fn resolve_team_dir_prefers_existing_workspace_link() {
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path();
        let linked = workspace.join(crate::commands::TEAM_REPO_DIR);
        std::fs::create_dir_all(&linked).unwrap();

        let resolved = resolve_team_dir(workspace, Some("team-abc")).unwrap();
        assert_eq!(resolved, linked);
    }

    #[test]
    fn resolve_team_dir_falls_back_to_global_when_workspace_unlinked() {
        let _guard = home_lock().lock().unwrap();
        let home_dir = tempfile::tempdir().unwrap();
        let _home = HomeGuard::set(home_dir.path());

        // A daemon-owned session workspace with no `teamclaw-team` link.
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path();
        assert!(!workspace.join(crate::commands::TEAM_REPO_DIR).exists());

        let resolved = resolve_team_dir(workspace, Some("team-abc")).unwrap();

        let expected = home_dir
            .path()
            .join(".amuxd")
            .join("teams")
            .join("team-abc")
            .join(crate::commands::TEAM_REPO_DIR);
        assert_eq!(resolved, expected);
        assert!(
            resolved.exists(),
            "global team dir should be created so the first write can land"
        );
    }

    #[test]
    fn resolve_team_dir_without_team_id_keeps_workspace_path() {
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path();

        let resolved = resolve_team_dir(workspace, None).unwrap();
        assert_eq!(resolved, workspace.join(crate::commands::TEAM_REPO_DIR));
    }

    #[test]
    fn lazy_init_uses_shared_dir_and_env_secret() {
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path();
        let config_dir = workspace.join(crate::commands::TEAMCLAW_DIR);
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join(crate::commands::CONFIG_FILE_NAME),
            serde_json::json!({
                "team": {
                    "gitUrl": "https://example.com/repo.git",
                    "enabled": true,
                    "lastSyncAt": null,
                    "sharedDirName": "teamclaw",
                    "envSecret": "00".repeat(32)
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::create_dir_all(workspace.join("teamclaw")).unwrap();

        let state = SharedSecretsState::default();
        let result = try_lazy_init_from_workspace(&state, workspace.to_str().unwrap(), None);

        assert!(result.is_ok());
        let team_dir = state.team_dir.lock().unwrap().clone().unwrap();
        assert_eq!(team_dir, workspace.join("teamclaw"));
    }

    #[test]
    fn lazy_init_reinitializes_when_workspace_team_config_changes() {
        let workspace_a_dir = tempfile::tempdir().unwrap();
        let workspace_b_dir = tempfile::tempdir().unwrap();
        let workspace_a = workspace_a_dir.path();
        let workspace_b = workspace_b_dir.path();
        for (workspace, secret) in [
            (workspace_a, "00".repeat(32)),
            (workspace_b, "11".repeat(32)),
        ] {
            let config_dir = workspace.join(crate::commands::TEAMCLAW_DIR);
            std::fs::create_dir_all(&config_dir).unwrap();
            std::fs::write(
                config_dir.join(crate::commands::CONFIG_FILE_NAME),
                serde_json::json!({
                    "team": {
                        "gitUrl": "https://example.com/repo.git",
                        "enabled": true,
                        "lastSyncAt": null,
                        "sharedDirName": "teamclaw",
                        "envSecret": secret
                    }
                })
                .to_string(),
            )
            .unwrap();
            std::fs::create_dir_all(workspace.join("teamclaw")).unwrap();
        }

        let state = SharedSecretsState::default();
        try_lazy_init_from_workspace(&state, workspace_a.to_str().unwrap(), None).unwrap();
        try_lazy_init_from_workspace(&state, workspace_b.to_str().unwrap(), None).unwrap();

        let team_dir = state.team_dir.lock().unwrap().clone().unwrap();
        let derived_key = state.derived_key.lock().unwrap().unwrap();
        assert_eq!(team_dir, workspace_b.join("teamclaw"));
        assert_eq!(
            derived_key,
            derive_key(&"11".repeat(32)).expect("derive workspace b key")
        );
    }
}
