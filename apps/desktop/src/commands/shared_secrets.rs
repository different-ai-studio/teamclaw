//! Shared secrets — team env vars, encrypted with the team key.
//!
//! Writes are routed through `env_catalog_set` / `env_catalog_delete`; this module
//! owns encryption, in-memory cache, and lazy init from workspace config.
//!
//! # Storage
//!
//! Values live in the Cloud API (`/v1/teams/:id/env-secrets`); the legacy
//! `<team_dir>/_secrets/*.enc.json` files are still read so a workspace that has
//! not been migrated keeps working, but nothing writes them and `_secrets/` is
//! no longer synced — so they can only exist on a machine that already had them.
//! See `docs/architecture/team-mcp-and-env-cloud.md`.
//!
//! What did NOT change is the part that matters: encryption still happens here,
//! on this machine, with the team key. The server stores an opaque
//! `{v, nonce, ciphertext}` envelope and cannot read it — the same guarantee the
//! OSS/git storage had, since that was always client-encrypted too. Only the
//! transport moved.
//!
//! One consequence worth knowing: the cloud path needs the derived key but not a
//! `team_dir`, which is why key resolution is split out from
//! `try_lazy_init_from_workspace`. Requiring the directory would have made team
//! env unwritable exactly where it is most useful — a machine that has joined a
//! team but never synced its shared folder.

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

// The `_secrets/*.enc.json` writer and deleter are gone: values are written to
// the Cloud API now, and a helper that still wrote files nobody reads back would
// be a trap for the next person. `load_all_secrets` below still reads the
// directory so an unmigrated workspace is not silently blank.

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
    let env_secret = teamclaw_runtime_env::env_catalog::resolve_team_env_secret(
        workspace,
        team_id,
        Some(super::APP_SHORT_NAME),
    )
    .ok_or_else(|| {
        "Missing team encryption key for this workspace (not initialized). Configure it under Settings → Daemon → General, then try again.".to_string()
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

/// Resolve (and cache) just the team encryption key for a workspace.
///
/// Split out from [`try_lazy_init_from_workspace`] because the cloud path needs
/// the key and nothing else. That function additionally resolves a `team_dir`
/// and fails when the shared folder was never synced — a legitimate state for a
/// member who joined a team but has no local copy of it, and one that must not
/// block writing a team env var.
fn ensure_derived_key(
    state: &SharedSecretsState,
    workspace_path: &str,
    team_id: Option<&str>,
) -> Result<[u8; 32], String> {
    let workspace = Path::new(workspace_path);
    let env_secret = teamclaw_runtime_env::env_catalog::resolve_team_env_secret(
        workspace,
        team_id,
        Some(super::APP_SHORT_NAME),
    )
    .ok_or_else(|| {
        "Missing team encryption key for this workspace (not initialized). Configure it under Settings → Daemon → General, then try again.".to_string()
    })?;
    let derived_key = derive_key(&env_secret)?;
    let mut dk = state
        .derived_key
        .lock()
        .map_err(|e| format!("ensure_derived_key: lock derived_key: {e}"))?;
    *dk = Some(derived_key);
    Ok(derived_key)
}

/// The Cloud API client for team-secret calls, or `None` when this workspace has
/// no team / no signed-in session to authenticate with.
fn fc_client_for(
    workspace_path: &str,
    access_token: Option<&str>,
) -> Option<super::oss_sync::fc_client::FcClient> {
    let token = access_token.map(str::trim).filter(|t| !t.is_empty())?;
    // Endpoint comes from the build config, not from the caller — same rule the
    // rest of the Rust Cloud API surface follows (see `get_fc_endpoint`).
    let endpoint = super::oss_sync::get_fc_endpoint(workspace_path);
    Some(super::oss_sync::fc_client::FcClient::new(
        endpoint,
        token.to_string(),
    ))
}

fn teamclaw_config_path(workspace: &Path) -> PathBuf {
    workspace
        .join(super::TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME)
}

// ---------------------------------------------------------------------------
// Internal write helpers (used by env_catalog commands)
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
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
    access_token: Option<String>,
) -> Result<(), String> {
    validate_key_id(&key_id)?;

    let team_id = team_id
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "teamId is required for team env vars".to_string())?;

    // Only the key is needed to encrypt. Deliberately not `try_lazy_init_from_workspace`:
    // that also demands a synced `team_dir`, which would block a member who has
    // joined the team but never pulled its shared folder.
    let derived_key = ensure_derived_key(state, workspace_path, Some(&team_id))?;

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

    // Ciphertext only past this point — the plaintext never leaves the process.
    let client = fc_client_for(workspace_path, access_token.as_deref()).ok_or_else(|| {
        "Not signed in — team env vars are stored in the team's cloud account".to_string()
    })?;
    let body = serde_json::json!({ "envelope": envelope });
    client
        .put_json(
            &format!("/v1/teams/{}/env-secrets/{}", team_id, key_id),
            &body,
        )
        .await
        .map_err(|e| format!("Failed to save team env var: {e}"))?;

    // Only mirror into the cache once the write is durable, so a failed request
    // cannot leave this machine believing a value it never stored.
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

#[allow(clippy::too_many_arguments)]
pub(crate) async fn delete_secret_for_workspace(
    app_handle: &AppHandle,
    state: &SharedSecretsState,
    workspace_path: &str,
    key_id: String,
    node_id: String,
    role: String,
    team_id: Option<String>,
    access_token: Option<String>,
) -> Result<(), String> {
    validate_key_id(&key_id)?;

    let team_id = team_id
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "teamId is required for team env vars".to_string())?;

    // A local pre-check purely so the common case fails fast with a sentence a
    // person can act on. It is NOT the security boundary — RLS decides, and it
    // sees the real actor rather than this machine's node id. Note the cache can
    // be empty (nothing loaded yet), in which case this simply defers to the
    // server, which is the correct outcome either way.
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

    let client = fc_client_for(workspace_path, access_token.as_deref()).ok_or_else(|| {
        "Not signed in — team env vars are stored in the team's cloud account".to_string()
    })?;
    client
        .delete_json(&format!("/v1/teams/{}/env-secrets/{}", team_id, key_id))
        .await
        .map_err(|e| format!("Failed to delete team env var: {e}"))?;

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

/// Pull team env from the Cloud API and merge it over whatever the legacy
/// `_secrets/` files hold, then repopulate the in-memory cache.
///
/// Cloud wins on a key collision: a stale copy may still be sitting in a synced
/// team folder, and it is by definition older than the row the server returns.
///
/// A fetch failure leaves the cache alone rather than clearing it. An empty map
/// and "we could not ask" are different facts, and conflating them would blank
/// the user's team env whenever the network hiccups.
pub(crate) async fn refresh_team_secrets_from_cloud(
    state: &SharedSecretsState,
    workspace_path: &str,
    team_id: Option<&str>,
    access_token: Option<&str>,
) -> Result<(), String> {
    let Some(team_id) = team_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let derived_key = ensure_derived_key(state, workspace_path, Some(team_id))?;
    let Some(client) = fc_client_for(workspace_path, access_token) else {
        return Ok(());
    };

    let resp = client
        .get_json(&format!("/v1/teams/{}/env-secrets", team_id))
        .await
        .map_err(|e| format!("Failed to load team env vars: {e}"))?;

    let items = resp
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut fetched: HashMap<String, SecretEntry> = HashMap::new();
    for item in items {
        let Some(key_id) = item.get("keyId").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(envelope) = item.get("envelope") else {
            continue;
        };
        let envelope: EncryptedEnvelope = match serde_json::from_value(envelope.clone()) {
            Ok(e) => e,
            Err(e) => {
                log::warn!("shared_secrets: bad envelope for '{key_id}': {e}");
                continue;
            }
        };
        // Undecryptable rows are skipped, not fatal: a key rotation would
        // otherwise make the whole list unreadable instead of just its stale part.
        match decrypt_secret(&envelope, &derived_key) {
            Ok(entry) => {
                fetched.insert(key_id.to_string(), entry);
            }
            Err(e) => log::warn!("shared_secrets: cannot decrypt '{key_id}': {e}"),
        }
    }

    {
        let mut secrets = state
            .secrets
            .lock()
            .map_err(|e| format!("refresh_team_secrets_from_cloud: lock secrets: {e}"))?;
        for (key, entry) in fetched {
            secrets.insert(key, entry);
        }
    }
    Ok(())
}

/// Refresh from the Cloud API and return the team entries as catalog listings.
///
/// The settings/browser list is built by scanning `_secrets/` on disk, which
/// finds nothing now that writes go to the cloud — this is what puts the values
/// back in front of the user.
pub(crate) async fn team_listings_from_cloud(
    state: &SharedSecretsState,
    workspace_path: &str,
    team_id: Option<&str>,
    access_token: Option<&str>,
) -> Result<Vec<teamclaw_runtime_env::env_catalog::TeamEnvListing>, String> {
    refresh_team_secrets_from_cloud(state, workspace_path, team_id, access_token).await?;

    let secrets = state
        .secrets
        .lock()
        .map_err(|e| format!("team_listings_from_cloud: lock secrets: {e}"))?;
    let mut out: Vec<_> = secrets
        .values()
        .map(|e| teamclaw_runtime_env::env_catalog::TeamEnvListing {
            key_id: e.key_id.clone(),
            description: e.description.clone(),
            category: e.category.clone(),
            created_by: e.created_by.clone(),
            updated_by: e.updated_by.clone(),
            updated_at: e.updated_at.clone(),
            // Everything here came back from `decrypt_secret`, so by construction
            // it decrypted. Rows that did not are dropped upstream with a warning
            // rather than surfaced as undecryptable, because unlike the file scan
            // there is no filename to show a key we cannot read.
            decrypted: true,
            key_mismatch: false,
        })
        .collect();
    out.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    Ok(out)
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

        let expected = crate::commands::amuxd_home_dir()
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
