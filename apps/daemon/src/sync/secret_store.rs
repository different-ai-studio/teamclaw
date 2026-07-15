//! Encrypted per-team secret custody for daemon-owned sync.
//!
//! Layout: `<base>/secret.key` (32-byte master key, 0600) +
//! `<base>/teams/<team_id>/secrets.enc` (AMXC blob of the JSON below).
//! `<base>` defaults to `~/.amuxd`.
//!
//! NOTE: `SecretStore::with_base` is reserved for testing / alternate-base
//! instantiation paths not yet exercised in the dispatcher.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::sync::oss::crypto::{decrypt_blob, encrypt_blob};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSecrets {
    #[serde(default)]
    pub oss_team_secret: Option<String>,
    #[serde(default)]
    pub user_jwt: Option<String>,
    #[serde(default)]
    pub git_credential: Option<String>,
    /// Git branch for git-backed sync. FC does not surface the branch via
    /// `share-mode`, so the desktop delivers it here at enable time.
    #[serde(default)]
    pub git_branch: Option<String>,
}

#[derive(Clone)]
pub struct SecretStore {
    base: PathBuf,
}

impl SecretStore {
    /// Create a store rooted at the default daemon config dir (`~/.amuxd`).
    #[allow(dead_code)] // used by dispatch/http in later tasks
    pub fn new() -> Self {
        Self {
            base: crate::config::DaemonConfig::config_dir(),
        }
    }

    pub fn with_base(base: PathBuf) -> Self {
        Self { base }
    }

    fn master_key(&self) -> Result<[u8; 32], String> {
        let key_path = self.base.join("secret.key");
        // Fast path: an existing 32-byte key wins.
        if let Ok(bytes) = std::fs::read(&key_path) {
            if bytes.len() == 32 {
                let mut k = [0u8; 32];
                k.copy_from_slice(&bytes);
                return Ok(k);
            }
        }
        std::fs::create_dir_all(&self.base).map_err(|e| e.to_string())?;
        let mut k = [0u8; 32];
        getrandom::getrandom(&mut k).map_err(|e| format!("secret.key gen: {e}"))?;
        use std::io::Write;
        // Atomic create: only one concurrent first-time caller wins the create_new
        // race and writes its key. Losers fall through to re-read the winner's key,
        // so secrets stay decryptable under a single stable master key.
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&key_path)
        {
            Ok(mut f) => {
                f.write_all(&k)
                    .map_err(|e| format!("write secret.key: {e}"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ =
                        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
                }
                Ok(k)
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Lost the race — read the winner's key.
                let bytes =
                    std::fs::read(&key_path).map_err(|e| format!("read secret.key: {e}"))?;
                if bytes.len() != 32 {
                    return Err("secret.key has wrong length".into());
                }
                let mut kk = [0u8; 32];
                kk.copy_from_slice(&bytes);
                Ok(kk)
            }
            Err(e) => Err(format!("create secret.key: {e}")),
        }
    }

    fn secrets_path(&self, team_id: &str) -> PathBuf {
        self.base.join("teams").join(team_id).join("secrets.enc")
    }

    pub fn load(&self, team_id: &str) -> Result<TeamSecrets, String> {
        let path = self.secrets_path(team_id);
        let blob = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => return Ok(TeamSecrets::default()),
        };
        let key = self.master_key()?;
        let plain = decrypt_blob(&blob, &key)?;
        serde_json::from_slice(&plain).map_err(|e| format!("parse secrets: {e}"))
    }

    pub fn save(&self, team_id: &str, secrets: &TeamSecrets) -> Result<(), String> {
        let key = self.master_key()?;
        let plain = serde_json::to_vec(secrets).map_err(|e| e.to_string())?;
        let blob = encrypt_blob(&plain, &key)?;
        let path = self.secrets_path(team_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, blob).map_err(|e| format!("write secrets: {e}"))
    }

    /// Merge non-None fields from `incoming` into the stored secrets.
    pub fn merge(&self, team_id: &str, incoming: &TeamSecrets) -> Result<(), String> {
        let mut current = self.load(team_id)?;
        if incoming.oss_team_secret.is_some() {
            current.oss_team_secret = incoming.oss_team_secret.clone();
        }
        if incoming.user_jwt.is_some() {
            current.user_jwt = incoming.user_jwt.clone();
        }
        if incoming.git_credential.is_some() {
            current.git_credential = incoming.git_credential.clone();
        }
        if incoming.git_branch.is_some() {
            current.git_branch = incoming.git_branch.clone();
        }
        self.save(team_id, &current)
    }

    /// Resolve the stored git credential, typed by the FC `git_auth_kind`.
    /// `ssh_key` yields an SSH PEM credential, `https_token` (or anything else)
    /// yields an HTTPS token. No stored credential yields `None`.
    pub fn git_credential(
        &self,
        team_id: &str,
        auth_kind: Option<&str>,
    ) -> Result<crate::sync::git::GitCredential, String> {
        let s = self.load(team_id)?;
        Ok(match (s.git_credential, auth_kind) {
            (Some(c), Some("ssh_key")) => crate::sync::git::GitCredential::SshKey(c),
            (Some(c), Some("https_token")) => crate::sync::git::GitCredential::HttpsToken(c),
            (Some(c), _) => crate::sync::git::GitCredential::HttpsToken(c), // default to https
            (None, _) => crate::sync::git::GitCredential::None,
        })
    }

    /// The stored git branch, if any.
    pub fn git_branch(&self, team_id: &str) -> Option<String> {
        self.load(team_id).ok().and_then(|s| s.git_branch)
    }

    /// Resolve just the OSS team secret: store > config env_secret.
    ///
    /// The FC bearer for OSS sync is no longer sourced here — the daemon
    /// self-supplies it from its own auto-refreshing cloud token
    /// (`SyncDispatcher::oss_jwt`), so a stale delivered JWT can't stall
    /// headless sync.
    pub fn resolve_team_secret(
        &self,
        team_id: &str,
        config_env_secret: Option<&str>,
    ) -> Result<String, String> {
        let stored = self.load(team_id)?;
        stored
            .oss_team_secret
            .or_else(|| config_env_secret.map(str::to_string))
            .ok_or_else(|| format!("no OSS team secret for {team_id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_secrets_via_explicit_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::with_base(tmp.path().to_path_buf());
        let secrets = TeamSecrets {
            oss_team_secret: Some(
                "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20".into(),
            ),
            user_jwt: Some("jwt-abc".into()),
            git_credential: None,
            git_branch: Some("release".into()),
        };
        store.save("team-x", &secrets).unwrap();
        let loaded = store.load("team-x").unwrap();
        assert_eq!(
            loaded.oss_team_secret.as_deref(),
            secrets.oss_team_secret.as_deref()
        );
        assert_eq!(loaded.user_jwt.as_deref(), Some("jwt-abc"));
        assert_eq!(loaded.git_branch.as_deref(), Some("release"));
    }

    #[test]
    fn missing_team_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::with_base(tmp.path().to_path_buf());
        let loaded = store.load("nope").unwrap();
        assert!(loaded.oss_team_secret.is_none() && loaded.user_jwt.is_none());
    }

    #[test]
    fn master_key_is_stable_across_instances() {
        let tmp = tempfile::tempdir().unwrap();
        let s1 = SecretStore::with_base(tmp.path().to_path_buf());
        s1.save(
            "t",
            &TeamSecrets {
                oss_team_secret: Some("ff".repeat(32)),
                user_jwt: None,
                git_credential: None,
                git_branch: None,
            },
        )
        .unwrap();
        let s2 = SecretStore::with_base(tmp.path().to_path_buf());
        assert_eq!(s2.load("t").unwrap().oss_team_secret, Some("ff".repeat(32)));
    }

    #[test]
    fn resolve_team_secret_prefers_store_then_config_env_secret() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::with_base(tmp.path().to_path_buf());
        let cfg_secret = Some("aa".repeat(32));
        // No stored secret yet: falls back to the config env_secret.
        let resolved = store
            .resolve_team_secret("team-y", cfg_secret.as_deref())
            .unwrap();
        assert_eq!(resolved, "aa".repeat(32));
        // A stored team secret wins over the config env_secret.
        store
            .merge(
                "team-y",
                &TeamSecrets {
                    oss_team_secret: Some("bb".repeat(32)),
                    user_jwt: None,
                    git_credential: None,
                    git_branch: None,
                },
            )
            .unwrap();
        let resolved = store
            .resolve_team_secret("team-y", cfg_secret.as_deref())
            .unwrap();
        assert_eq!(resolved, "bb".repeat(32));
        // Neither store nor config: error.
        assert!(store.resolve_team_secret("team-z", None).is_err());
    }

    #[test]
    fn git_credential_typed_by_auth_kind() {
        use crate::sync::git::GitCredential;
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::with_base(tmp.path().to_path_buf());
        // No stored credential → None regardless of auth_kind.
        assert!(matches!(
            store.git_credential("t", Some("ssh_key")).unwrap(),
            GitCredential::None
        ));
        store
            .merge(
                "t",
                &TeamSecrets {
                    git_credential: Some("CRED".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(matches!(
            store.git_credential("t", Some("ssh_key")).unwrap(),
            GitCredential::SshKey(c) if c == "CRED"
        ));
        assert!(matches!(
            store.git_credential("t", Some("https_token")).unwrap(),
            GitCredential::HttpsToken(c) if c == "CRED"
        ));
        // Unknown / absent auth_kind defaults to https.
        assert!(matches!(
            store.git_credential("t", None).unwrap(),
            GitCredential::HttpsToken(c) if c == "CRED"
        ));
    }
}
