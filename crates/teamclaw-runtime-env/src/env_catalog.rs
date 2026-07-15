//! Canonical env-var catalog — list and resolve metadata from one source.
//!
//! - Personal/system: `{workspace}/.teamclaw/teamclaw.json` → `envVars`
//! - Team: `{sharedDirName}/_secrets/*.enc.json` (Git default: `teamclaw/_secrets`)
//!
//! Desktop writes go through `env_catalog_set` / `env_catalog_delete`; daemon
//! runtime injection decrypts the same team paths via `team_shared_env`.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tracing::warn;

use crate::team_provider;

const TEAMCLAW_DIR: &str = ".teamclaw";
const CONFIG_FILE_NAME: &str = "teamclaw.json";
const SECRETS_SUBDIR: &str = "_secrets";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEnvListing {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEnvListing {
    pub key_id: String,
    pub description: String,
    pub category: String,
    pub created_by: String,
    pub updated_by: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCatalog {
    pub personal: Vec<PersonalEnvListing>,
    pub team: Vec<TeamEnvListing>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEnvListing {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct EncryptedEnvelope {
    v: u32,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretEntry {
    key_id: String,
    #[serde(default)]
    key: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    created_by: String,
    #[serde(default)]
    updated_by: String,
    #[serde(default)]
    updated_at: String,
}

fn teamclaw_config_path(workspace: &Path) -> PathBuf {
    workspace.join(TEAMCLAW_DIR).join(CONFIG_FILE_NAME)
}

pub fn read_teamclaw_config(workspace: &Path) -> Option<serde_json::Value> {
    let body = std::fs::read_to_string(teamclaw_config_path(workspace)).ok()?;
    serde_json::from_str(&body).ok()
}

fn read_team_json_env_secret(workspace: &Path) -> Option<String> {
    read_teamclaw_config(workspace)?
        .get("team")?
        .get("envSecret")?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Team env decryption key from `team.envSecret` or `_team_secret.{team_id}` blob.
pub fn resolve_team_env_secret(
    workspace: &Path,
    team_id: Option<&str>,
) -> Option<String> {
    if let Some(secret) = read_team_json_env_secret(workspace) {
        return Some(secret);
    }
    let team_id = team_id.filter(|id| !id.trim().is_empty())?;
    let blob_key = format!("_team_secret.{team_id}");
    crate::personal_secrets::load_personal_env()
        .ok()
        .and_then(|env| env.get(&blob_key).cloned())
        .filter(|s| !s.trim().is_empty())
}

/// Team shared directory for writes: `{workspace}/{sharedDirName}`.
pub fn resolve_team_dir_for_workspace(workspace: &Path) -> PathBuf {
    workspace.join(team_provider::resolve_shared_dir_name(workspace))
}

/// Workspace-local `_secrets/` candidates, most preferred first.
///
/// Git teams default to `{workspace}/teamclaw/_secrets`; newer layouts use the
/// `teamclaw-team` symlink. Callers with a global team store can prepend extra paths.
pub fn team_secrets_dir_candidates_workspace(
    workspace: &Path,
    shared_dir_name: &str,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |path: PathBuf| {
        if seen.insert(path.clone()) {
            out.push(path);
        }
    };

    push(workspace.join(crate::DEFAULT_TEAM_REPO_DIR).join(SECRETS_SUBDIR));
    if shared_dir_name != crate::DEFAULT_TEAM_REPO_DIR {
        push(workspace.join(shared_dir_name).join(SECRETS_SUBDIR));
    }
    // Legacy desktop default before sharedDirName was aligned with teamclaw-team.
    push(workspace.join("teamclaw").join(SECRETS_SUBDIR));
    out
}

fn derive_key(env_secret: &str) -> anyhow::Result<[u8; 32]> {
    let ikm = hex::decode(env_secret)?;
    if ikm.len() != 32 {
        anyhow::bail!("env_secret must be 32 bytes (64 hex chars)");
    }
    let hk = Hkdf::<Sha256>::new(Some(b"teamclaw-secrets-v1"), &ikm);
    let mut okm = [0_u8; 32];
    hk.expand(b"aes-256-gcm", &mut okm)
        .map_err(|_| anyhow::anyhow!("HKDF expand failed"))?;
    Ok(okm)
}

fn decrypt_secret(envelope: &EncryptedEnvelope, key: &[u8; 32]) -> anyhow::Result<SecretEntry> {
    if envelope.v != 1 {
        anyhow::bail!("unsupported envelope version {}", envelope.v);
    }
    let nonce_bytes = BASE64.decode(&envelope.nonce)?;
    if nonce_bytes.len() != 12 {
        anyhow::bail!("nonce must be 12 bytes");
    }
    let ciphertext = BASE64.decode(&envelope.ciphertext)?;
    let cipher = Aes256Gcm::new_from_slice(key)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| anyhow::anyhow!("AES-GCM decrypt failed"))?;
    Ok(serde_json::from_slice(&plaintext)?)
}

fn load_team_env_metas_from_dir(
    secrets_dir: &Path,
    env_secret: &str,
) -> anyhow::Result<Vec<TeamEnvListing>> {
    if !secrets_dir.exists() {
        return Ok(Vec::new());
    }

    let key = derive_key(env_secret)?;
    let mut out = Vec::new();

    for entry in std::fs::read_dir(secrets_dir)? {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(e) => {
                warn!("env_catalog: failed to read team secret directory entry: {e}");
                continue;
            }
        };
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".enc.json") {
            continue;
        }
        let body = match std::fs::read_to_string(&path) {
            Ok(body) => body,
            Err(e) => {
                warn!(path = %path.display(), "env_catalog: failed to read team secret file: {e}");
                continue;
            }
        };
        let envelope: EncryptedEnvelope = match serde_json::from_str(&body) {
            Ok(envelope) => envelope,
            Err(e) => {
                warn!(path = %path.display(), "env_catalog: failed to parse team secret file: {e}");
                continue;
            }
        };
        let secret = match decrypt_secret(&envelope, &key) {
            Ok(secret) => secret,
            Err(e) => {
                warn!(path = %path.display(), "env_catalog: failed to decrypt team secret file: {e}");
                continue;
            }
        };
        out.push(TeamEnvListing {
            key_id: secret.key_id,
            description: secret.description,
            category: if secret.category.is_empty() {
                "custom".to_string()
            } else {
                secret.category
            },
            created_by: secret.created_by,
            updated_by: secret.updated_by,
            updated_at: secret.updated_at,
        });
    }
    Ok(out)
}

fn load_team_env_keys_from_dir(secrets_dir: &Path) -> Vec<String> {
    let Ok(read_dir) = std::fs::read_dir(secrets_dir) else {
        return Vec::new();
    };
    read_dir
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .strip_suffix(".enc.json")
                .map(str::to_string)
        })
        .collect()
}

/// Load team secret metadata by scanning all workspace `_secrets/` candidates.
pub fn load_team_env_listings(
    workspace: &Path,
    team_id: Option<&str>,
) -> Vec<TeamEnvListing> {
    let shared_dir_name = team_provider::resolve_shared_dir_name(workspace);
    let Some(env_secret) = resolve_team_env_secret(workspace, team_id) else {
        return load_team_env_key_only_listings(workspace, &shared_dir_name);
    };

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for secrets_dir in team_secrets_dir_candidates_workspace(workspace, &shared_dir_name) {
        let Ok(metas) = load_team_env_metas_from_dir(&secrets_dir, &env_secret) else {
            continue;
        };
        for meta in metas {
            if seen.insert(meta.key_id.to_ascii_lowercase()) {
                out.push(meta);
            }
        }
    }
    out.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    out
}

fn load_team_env_key_only_listings(
    workspace: &Path,
    shared_dir_name: &str,
) -> Vec<TeamEnvListing> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for secrets_dir in team_secrets_dir_candidates_workspace(workspace, shared_dir_name) {
        for key in load_team_env_keys_from_dir(&secrets_dir) {
            if seen.insert(key.to_ascii_lowercase()) {
                out.push(TeamEnvListing {
                    key_id: key,
                    description: String::new(),
                    category: "team".to_string(),
                    created_by: String::new(),
                    updated_by: String::new(),
                    updated_at: String::new(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    out
}

pub fn load_personal_env_listings(workspace: &Path) -> Vec<PersonalEnvListing> {
    let Some(config) = read_teamclaw_config(workspace) else {
        return Vec::new();
    };
    config
        .get("envVars")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let key = entry.get("key")?.as_str()?.to_string();
                    Some(PersonalEnvListing {
                        key,
                        description: entry
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        category: entry
                            .get("category")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn load_env_catalog(workspace: &Path, team_id: Option<&str>) -> EnvCatalog {
    EnvCatalog {
        personal: load_personal_env_listings(workspace),
        team: load_team_env_listings(workspace, team_id),
    }
}

/// Personal `envVars` index merged with team keys — shape used by agent tools.
pub fn load_agent_env_listings(workspace: &Path, team_id: Option<&str>) -> Vec<AgentEnvListing> {
    let personal = load_personal_env_listings(workspace);
    let team = load_team_env_listings(workspace, team_id);

    let mut out: Vec<AgentEnvListing> = personal
        .into_iter()
        .map(|entry| AgentEnvListing {
            key: entry.key,
            description: entry.description,
            category: entry.category,
        })
        .collect();

    let personal_keys: HashSet<String> = out
        .iter()
        .map(|entry| entry.key.to_ascii_lowercase())
        .collect();

    for meta in team {
        if personal_keys.contains(&meta.key_id.to_ascii_lowercase()) {
            continue;
        }
        out.push(AgentEnvListing {
            key: meta.key_id,
            description: if meta.description.is_empty() {
                None
            } else {
                Some(meta.description)
            },
            category: Some(if meta.category.is_empty() {
                "team".to_string()
            } else {
                meta.category
            }),
        });
    }

    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;

    fn encrypted_secret_file(env_secret: &str, key_id: &str, key_value: &str) -> String {
        let key = derive_key(env_secret).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce = [9_u8; 12];
        let secret = SecretEntry {
            key_id: key_id.to_string(),
            key: key_value.to_string(),
            description: "desc".to_string(),
            category: "custom".to_string(),
            created_by: "node-a".to_string(),
            updated_by: "node-a".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let plaintext = serde_json::to_vec(&secret).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .unwrap();
        serde_json::to_string(&EncryptedEnvelope {
            v: 1,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        })
        .unwrap()
    }

    #[test]
    fn git_team_listings_read_teamclaw_shared_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let env_secret = "55".repeat(32);
        std::fs::create_dir_all(tmp.path().join(".teamclaw")).unwrap();
        std::fs::write(
            tmp.path().join(".teamclaw/teamclaw.json"),
            serde_json::json!({
                "team": {
                    "gitUrl": "https://example.com/team.git",
                    "sharedDirName": "teamclaw",
                    "envSecret": env_secret
                }
            })
            .to_string(),
        )
        .unwrap();
        let secrets_dir = tmp.path().join("teamclaw/_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(
            secrets_dir.join("git_key.enc.json"),
            encrypted_secret_file(&env_secret, "git_key", "secret"),
        )
        .unwrap();

        let team = load_team_env_listings(tmp.path(), None);
        assert_eq!(team.len(), 1);
        assert_eq!(team[0].key_id, "git_key");
        assert_eq!(team[0].description, "desc");
    }

    #[test]
    fn agent_listing_merges_personal_and_team_without_duplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let env_secret = "66".repeat(32);
        std::fs::create_dir_all(tmp.path().join(".teamclaw")).unwrap();
        std::fs::write(
            tmp.path().join(".teamclaw/teamclaw.json"),
            serde_json::json!({
                "envVars": [
                    { "key": "tc_api_key", "category": "system" },
                    { "key": "mine", "description": "personal" }
                ],
                "team": {
                    "sharedDirName": "teamclaw",
                    "envSecret": env_secret
                }
            })
            .to_string(),
        )
        .unwrap();
        let secrets_dir = tmp.path().join("teamclaw/_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(
            secrets_dir.join("team_only.enc.json"),
            encrypted_secret_file(&env_secret, "team_only", "x"),
        )
        .unwrap();

        let listings = load_agent_env_listings(tmp.path(), None);
        let keys: Vec<_> = listings.iter().map(|entry| entry.key.as_str()).collect();
        assert!(keys.contains(&"tc_api_key"));
        assert!(keys.contains(&"mine"));
        assert!(keys.contains(&"team_only"));
        assert_eq!(keys.len(), 3);
    }

    /// Write a personal-secrets blob (`$HOME/.teamclaw/secrets/`) matching the
    /// layout `personal_secrets::load_personal_env` reads.
    fn write_personal_secret_blob(home: &Path, entries: &[(&str, &str)]) {
        let secrets_dir = home.join(".teamclaw").join("secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        let key = [7_u8; 32];
        std::fs::write(secrets_dir.join("master.key"), key).unwrap();

        let map: serde_json::Map<String, serde_json::Value> = entries
            .iter()
            .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
            .collect();
        let plaintext = serde_json::to_vec(&map).unwrap();
        let nonce = [3_u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .unwrap();
        let blob = serde_json::json!({
            "nonce_b64": BASE64.encode(nonce),
            "ciphertext_b64": BASE64.encode(ciphertext),
        });
        std::fs::write(
            secrets_dir.join("personal-secrets.json.enc"),
            serde_json::to_vec(&blob).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn resolve_team_env_secret_falls_back_to_personal_blob_with_team_id() {
        let _lock = crate::test_util::home_env_lock();
        let home = tempfile::tempdir().unwrap();
        let _home_guard = crate::test_util::HomeGuard::set(home.path());

        // Workspace has a team config but NO inline `team.envSecret`.
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join(".teamclaw")).unwrap();
        std::fs::write(
            workspace.path().join(".teamclaw/teamclaw.json"),
            serde_json::json!({ "team": { "sharedDirName": "teamclaw" } }).to_string(),
        )
        .unwrap();

        let team_id = "4b8e9df9-c8c5-4d6b-b074-986eef7d02d1";
        let env_secret = "aa".repeat(32);
        write_personal_secret_blob(
            home.path(),
            &[(&format!("_team_secret.{team_id}"), &env_secret)],
        );

        // Without team_id the inline secret is missing → None (this was the bug:
        // the write/delete path passed None and hard-errored).
        assert_eq!(resolve_team_env_secret(workspace.path(), None), None);

        // With team_id the personal-blob fallback resolves the secret.
        assert_eq!(
            resolve_team_env_secret(workspace.path(), Some(team_id)).as_deref(),
            Some(env_secret.as_str())
        );
    }
}
