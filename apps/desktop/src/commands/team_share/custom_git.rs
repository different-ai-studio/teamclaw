//! Task 7 — custom Git SSH + HTTPS credential bridge.
//!
//! Provides a clean API for:
//!   - `store_credential`: persists a Git credential under
//!     `_git_credential.{ref}` in the local encrypted env_blob.
//!   - `load_credential`: reads the credential back. Used externally by the
//!     `teamclaw-askpass` sidecar binary (for HTTPS tokens) and by team-share
//!     enable (for SSH key delivery).
//!
//! Credential shape on disk (one entry per ref):
//!
//! ```json
//! "_git_credential.custom_git:t1": {
//!   "authKind": "https_token" | "ssh_key",
//!   "credential": "<token-or-key-path>"
//! }
//! ```
//!
//! For `https_token`, the credential is the literal token. For `ssh_key`,
//! the credential is a filesystem path to the private key.
//!
//! NOTE (Plan B Task 8): the clone path (`build_clone_command` / `clone_or_init`)
//! was removed — the daemon owns all team-repo cloning now.

use serde_json::json;

use crate::commands::env_vars;

const KEY_PREFIX: &str = "_git_credential.";

fn key_for(credential_ref: &str) -> String {
    format!("{}{}", KEY_PREFIX, credential_ref)
}

/// Persist a Git credential under `_git_credential.{ref}` in env_blob.
///
/// `kind` must be `"ssh_key"` or `"https_token"`. For `ssh_key`, `value`
/// is the absolute path to the private key file. For `https_token`,
/// `value` is the literal token.
pub fn store_credential(
    workspace_path: &str,
    credential_ref: &str,
    kind: &str,
    value: &str,
) -> Result<(), String> {
    if kind != "ssh_key" && kind != "https_token" {
        return Err(format!(
            "invalid credential kind `{}`; expected `ssh_key` or `https_token`",
            kind
        ));
    }
    let mut blob = env_vars::read_env_blob(workspace_path)?;
    blob.insert(
        key_for(credential_ref),
        json!({
            "authKind": kind,
            "credential": value,
        }),
    );
    env_vars::write_env_blob(&blob)
}

/// Load a Git credential, returning `(kind, value)`.
pub fn load_credential(
    workspace_path: &str,
    credential_ref: &str,
) -> Result<(String, String), String> {
    let blob = env_vars::read_env_blob(workspace_path)?;
    let entry = blob
        .get(&key_for(credential_ref))
        .ok_or_else(|| format!("git credential not found: {credential_ref}"))?;
    let kind = entry
        .get("authKind")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("git credential `{credential_ref}` missing authKind"))?
        .to_string();
    let value = entry
        .get("credential")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("git credential `{credential_ref}` missing credential"))?
        .to_string();
    Ok((kind, value))
}

/// Remove a stored Git credential (best-effort during local disconnect).
pub fn delete_credential(workspace_path: &str, credential_ref: &str) -> Result<(), String> {
    let mut blob = env_vars::read_env_blob(workspace_path)?;
    blob.remove(&key_for(credential_ref));
    env_vars::write_env_blob(&blob)
}
