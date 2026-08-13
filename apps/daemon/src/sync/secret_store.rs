//! Encrypted per-team secret custody for daemon-owned sync.
//!
//! Layout: `<base>/teams/<team_id>/state/secret.key` (32-byte key, 0600) +
//! `.../state/secrets.enc` (AMXC blob of the JSON below). `<base>` defaults to
//! `~/.amuxd`.
//!
//! These used to sit directly under `<base>`, deliberately *outside*
//! `teams/<team_id>/` — that directory also held the `teamclu-team` git
//! checkout, which `sync::git` stages with a blanket `git add -A` and pushes,
//! and nothing that must never reach a remote may neighbour a work tree.
//!
//! The checkout has since moved down into `teams/<team_id>/shared/`, the only
//! path the sync engine scans, so `state/` is out of its reach by construction
//! rather than by avoiding the whole team directory. That buys two things the
//! flat layout could not: `rm -rf teams/<id>` destroys the key together with
//! the blob it opens, and one team's key is no longer the key to every other
//! team's secrets.
//!
//! NOTE: `SecretStore::with_base` is reserved for testing / alternate-base
//! instantiation paths not yet exercised in the dispatcher.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::sync::oss::crypto::{decrypt_blob, encrypt_blob};

/// Owner-only. The blob is encrypted, so this is defence in depth rather than
/// the primary control — but every other credential the daemon writes is 0600,
/// and a world-readable ciphertext is one offline crack away from the plaintext.
#[cfg(unix)]
fn restrict(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) {}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSecrets {
    /// The team secret, despite the OSS-flavoured name. It is not OSS-specific:
    /// OSS sync uses it to encrypt blobs, and *every* share mode uses it to
    /// derive the key for `_secrets/` team-env decryption (see
    /// `team_shared_env::derive_key`). Read it via
    /// [`SecretStore::team_secret`]. The name is load-bearing on the wire —
    /// it matches the desktop's `ossTeamSecret` field in
    /// `POST /v1/team/secrets` — so it stays put.
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
    /// Channel credentials (bot tokens, app secrets, …), keyed by their dotted
    /// path in team.toml with array elements keyed by `bot_id`
    /// (`channels.wecom.bots[b-1].secret`). Written by
    /// `config::team_config::save_value`, which strips these out of the
    /// plaintext team.toml; nothing else writes this map.
    #[serde(default)]
    pub channel_secrets: std::collections::BTreeMap<String, String>,
}

/// The team secret is HKDF input keying material, not an opaque token: it must
/// decode to exactly 32 bytes or every blob and env var fails to decrypt.
///
/// Shared by `amuxd team secrets set` and `POST /v1/team/secrets` so a secret is
/// rejected at whichever door it arrives at, rather than being stored happily
/// and only surfacing as a decrypt failure on the next sync tick or agent spawn.
pub fn validate_team_secret(secret: &str) -> Result<(), String> {
    if secret.len() == 64 && secret.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err(format!(
        "team secret must be 64 hex chars (32 bytes), got {} char(s)",
        secret.len()
    ))
}

/// Show enough to tell two secrets apart, never enough to use one.
///
/// Shared by `amuxd team secrets show` and `GET /v1/team/secrets` so the CLI
/// and the setup UI cannot drift on how much of a credential they reveal.
/// Short values reveal nothing at all — a 8-char secret is short enough that
/// a 4+4 fingerprint would be the whole thing.
pub fn mask_secret(value: Option<&str>) -> String {
    match value {
        None => "(unset)".to_string(),
        Some(v) if v.len() <= 8 => "(set)".to_string(),
        Some(v) => format!("(set, {}…{})", &v[..4], &v[v.len() - 4..]),
    }
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

    /// One key per team, beside the blob it seals.
    ///
    /// A single key at the home root sealed every team's secrets, so deleting
    /// one team's directory left ciphertext elsewhere that the surviving key
    /// still opened. Per-team, destruction and rotation are both scoped.
    fn master_key(&self, team_id: &str) -> Result<[u8; 32], String> {
        let dir = crate::config::layout::team_state_dir_in(&self.base, team_id);
        let key_path = dir.join("secret.key");
        // Fast path: an existing 32-byte key wins.
        if let Ok(bytes) = std::fs::read(&key_path) {
            if bytes.len() == 32 {
                let mut k = [0u8; 32];
                k.copy_from_slice(&bytes);
                return Ok(k);
            }
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        restrict(&dir, 0o700);
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
        crate::config::layout::team_state_dir_in(&self.base, team_id).join("secrets.enc")
    }

    pub fn load(&self, team_id: &str) -> Result<TeamSecrets, String> {
        let path = self.secrets_path(team_id);
        let blob = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => return Ok(TeamSecrets::default()),
        };
        let key = self.master_key(team_id)?;
        let plain = decrypt_blob(&blob, &key)?;
        serde_json::from_slice(&plain).map_err(|e| format!("parse secrets: {e}"))
    }

    pub fn save(&self, team_id: &str, secrets: &TeamSecrets) -> Result<(), String> {
        let key = self.master_key(team_id)?;
        let plain = serde_json::to_vec(secrets).map_err(|e| e.to_string())?;
        let blob = encrypt_blob(&plain, &key)?;
        let path = self.secrets_path(team_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            restrict(parent, 0o700);
        }
        std::fs::write(&path, blob).map_err(|e| format!("write secrets: {e}"))?;
        restrict(&path, 0o600);
        Ok(())
    }

    /// Remove a team's stored secrets, and the key that opens them.
    ///
    /// The key goes too: leaving it would keep a usable key for a blob this
    /// daemon can no longer produce, and it belongs to this team alone now, so
    /// nothing else needs it. Absent files are not an error.
    pub fn clear(&self, team_id: &str) -> Result<(), String> {
        let dir = crate::config::layout::team_state_dir_in(&self.base, team_id);
        for path in [dir.join("secrets.enc"), dir.join("secret.key")] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("remove secrets: {e}")),
            }
        }
        Ok(())
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

    /// The stored team secret, or `None` when unset/blank.
    ///
    /// This daemon's copy is the system of record: it is the only source a
    /// standalone install can be handed one, whether by `amuxd team secrets set`
    /// or by the desktop's `POST /v1/team/secrets`.
    pub fn team_secret(&self, team_id: &str) -> Option<String> {
        self.load(team_id)
            .ok()
            .and_then(|s| s.oss_team_secret)
            .filter(|s| !s.trim().is_empty())
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
            channel_secrets: Default::default(),
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
                channel_secrets: Default::default(),
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
                    channel_secrets: Default::default(),
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

    #[test]
    fn a_team_with_nothing_stored_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::with_base(tmp.path().to_path_buf());
        assert!(store.load("never-seen").unwrap().oss_team_secret.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn secrets_are_written_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        let store = SecretStore::with_base(base.clone());
        store
            .save(
                "team-x",
                &TeamSecrets {
                    oss_team_secret: Some("33".repeat(32)),
                    ..Default::default()
                },
            )
            .unwrap();

        let dir = crate::config::layout::team_state_dir_in(&base, "team-x");
        for file in [dir.join("secrets.enc"), dir.join("secret.key")] {
            let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{} must not be world-readable", file.display());
        }

        let dir_mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
    }

    #[test]
    fn validate_team_secret_accepts_only_64_hex_chars() {
        assert!(validate_team_secret(&"ab".repeat(32)).is_ok());
        assert!(
            validate_team_secret(&"AB".repeat(32)).is_ok(),
            "hex is case-insensitive"
        );

        // A passphrase is the realistic wrong input: the desktop derives a key
        // from one, so a user may reasonably try the same thing here.
        let err = validate_team_secret("our-team-passphrase").unwrap_err();
        assert!(
            err.contains("64 hex"),
            "error must say what is expected: {err}"
        );

        assert!(validate_team_secret("").is_err());
        assert!(validate_team_secret(&"ab".repeat(31)).is_err(), "too short");
        assert!(validate_team_secret(&"ab".repeat(33)).is_err(), "too long");
        assert!(
            validate_team_secret(&"zz".repeat(32)).is_err(),
            "right length, not hex"
        );
    }

    /// A rejected secret must never be echoed back — error strings reach logs
    /// and HTTP responses.
    /// Each team seals under its own key, so clearing one cannot take another
    /// with it and one team's key is not the key to the rest.
    #[test]
    fn teams_do_not_share_a_key() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        let store = SecretStore::with_base(base.clone());

        for (team, secret) in [("team-a", "11"), ("team-b", "22")] {
            store
                .save(
                    team,
                    &TeamSecrets {
                        oss_team_secret: Some(secret.repeat(32)),
                        ..Default::default()
                    },
                )
                .unwrap();
        }

        let key_of = |team: &str| {
            std::fs::read(crate::config::layout::team_state_dir_in(&base, team).join("secret.key"))
                .unwrap()
        };
        assert_ne!(
            key_of("team-a"),
            key_of("team-b"),
            "a shared key defeats per-team destruction"
        );

        store.clear("team-a").unwrap();
        assert_eq!(
            store.load("team-b").unwrap().oss_team_secret,
            Some("22".repeat(32)),
            "clearing one team must not disturb another"
        );
        assert!(store.load("team-a").unwrap().oss_team_secret.is_none());
    }

    #[test]
    fn validate_team_secret_error_does_not_echo_the_value() {
        let err = validate_team_secret("hunter2-hunter2").unwrap_err();
        assert!(!err.contains("hunter2"));
    }

    #[test]
    fn mask_secret_never_reveals_a_usable_value() {
        assert_eq!(mask_secret(None), "(unset)");

        // Short enough that a 4+4 fingerprint would BE the whole secret.
        assert_eq!(mask_secret(Some("12345678")), "(set)");
        assert_eq!(mask_secret(Some("a")), "(set)");

        // Long values reveal a fingerprint only — enough to tell two apart.
        let oss = "0123456789abcdef0123456789abcdef";
        let masked = mask_secret(Some(oss));
        assert_eq!(masked, "(set, 0123…cdef)");
        assert!(!masked.contains(oss), "must never echo the secret itself");

        // Two different secrets are distinguishable.
        assert_ne!(
            mask_secret(Some(oss)),
            mask_secret(Some("ffff5555ffff5555"))
        );
    }
}
