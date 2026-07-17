//! Encrypted per-team secret custody for daemon-owned sync.
//!
//! Layout: `<base>/secret.key` (32-byte master key, 0600) +
//! `<base>/team-secrets/<team_id>.enc` (AMXC blob of the JSON below).
//! `<base>` defaults to `~/.amuxd`.
//!
//! These files live directly under `<base>`, alongside the other credential
//! files (`amuxd.cloud-token`, `amuxd.http.token`), and deliberately *not*
//! under `<base>/teams/<team_id>/` — that directory also holds the
//! `teamclaw-team` git checkout, which `sync::git` stages with a blanket
//! `git add -A` and pushes. Nothing that must never reach a remote should
//! neighbour a work tree; `sync::git` already backs conflicts up to
//! `.trash/` outside the tree for the same reason.
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
        self.base
            .join("team-secrets")
            .join(format!("{team_id}.enc"))
    }

    /// Pre-`team-secrets/` location: a sibling of the team's git checkout.
    fn legacy_secrets_path(&self, team_id: &str) -> PathBuf {
        self.base.join("teams").join(team_id).join("secrets.enc")
    }

    /// Move an already-onboarded daemon's secrets to the current location.
    ///
    /// The blob is encrypted under `<base>/secret.key`, which this move does not
    /// touch, so the bytes transfer verbatim. The legacy copy is removed only
    /// once the new one is read back and confirmed byte-identical: leaving it
    /// behind would defeat the point of moving it out of the checkout's
    /// directory, but losing it to a partial write would strand the team.
    ///
    /// Runs whenever a legacy file is present, not just when the new one is
    /// missing, so a failed reap on an earlier run self-heals instead of
    /// silently stranding a world-readable secret beside the work tree forever.
    ///
    /// Only the file is removed — `teams/<team_id>/` still holds the checkout
    /// and the default workspace.
    fn migrate_legacy(&self, team_id: &str) {
        let legacy = self.legacy_secrets_path(team_id);
        let Ok(legacy_blob) = std::fs::read(&legacy) else {
            return; // Nothing to migrate — the overwhelmingly common path.
        };
        let path = self.secrets_path(team_id);

        if !path.exists() {
            if let Some(parent) = path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    tracing::warn!(team_id, "team secret migration: create dir: {e}");
                    return;
                }
                restrict(parent, 0o700);
            }
            if let Err(e) = std::fs::write(&path, &legacy_blob) {
                tracing::warn!(team_id, "team secret migration: write: {e}");
                return;
            }
            restrict(&path, 0o600);
        }

        // Only reap a legacy copy the current file fully accounts for.
        match std::fs::read(&path) {
            Ok(current) if current == legacy_blob => match std::fs::remove_file(&legacy) {
                Ok(()) => tracing::info!(
                    team_id,
                    from = %legacy.display(),
                    to = %path.display(),
                    "migrated team secrets out of the team checkout directory"
                ),
                Err(e) => tracing::warn!(
                    team_id,
                    "team secrets are at {} but the old copy at {} could not be removed \
                     ({e}); it is world-readable and sits beside the team git checkout — \
                     delete it by hand",
                    path.display(),
                    legacy.display()
                ),
            },
            Ok(_) => tracing::warn!(
                team_id,
                "team secrets at {} differ from the old copy at {}; keeping both — the \
                 current file wins, remove the old one by hand once you have checked it",
                path.display(),
                legacy.display()
            ),
            Err(e) => tracing::warn!(
                team_id,
                "team secret migration could not verify {}: {e}; keeping {}",
                path.display(),
                legacy.display()
            ),
        }
    }

    pub fn load(&self, team_id: &str) -> Result<TeamSecrets, String> {
        self.migrate_legacy(team_id);
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
            restrict(parent, 0o700);
        }
        std::fs::write(&path, blob).map_err(|e| format!("write secrets: {e}"))?;
        restrict(&path, 0o600);
        Ok(())
    }

    /// Remove a team's stored secrets. Absent secrets are not an error.
    ///
    /// Clears the legacy location too, so a `clear` on a daemon that never
    /// happened to `load` first cannot leave a stale secret behind.
    pub fn clear(&self, team_id: &str) -> Result<(), String> {
        for path in [
            self.secrets_path(team_id),
            self.legacy_secrets_path(team_id),
        ] {
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

    /// An already-onboarded daemon keeps its secrets across the move, and the
    /// copy next to the git checkout is gone afterwards.
    #[test]
    fn legacy_secrets_migrate_out_of_the_team_checkout_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();

        // Write via the legacy layout, using the same master key the store uses.
        let seed = SecretStore::with_base(base.clone());
        seed.save(
            "team-x",
            &TeamSecrets {
                oss_team_secret: Some("ab".repeat(32)),
                git_branch: Some("main".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let new_path = base.join("team-secrets").join("team-x.enc");
        let legacy_path = base.join("teams").join("team-x").join("secrets.enc");
        std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        std::fs::rename(&new_path, &legacy_path).unwrap();
        assert!(!new_path.exists());

        // A fresh store finds and migrates it.
        let store = SecretStore::with_base(base.clone());
        let loaded = store.load("team-x").unwrap();
        assert_eq!(loaded.oss_team_secret, Some("ab".repeat(32)));
        assert_eq!(loaded.git_branch.as_deref(), Some("main"));

        assert!(new_path.exists(), "secrets should now live outside teams/");
        assert!(
            !legacy_path.exists(),
            "the copy beside the git checkout must not survive migration"
        );
    }

    /// The checkout and workspace share the legacy parent — migration must take
    /// the file, not the directory.
    #[test]
    fn migration_leaves_the_team_checkout_directory_intact() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        let seed = SecretStore::with_base(base.clone());
        seed.save(
            "team-x",
            &TeamSecrets {
                oss_team_secret: Some("cd".repeat(32)),
                ..Default::default()
            },
        )
        .unwrap();
        let team_dir = base.join("teams").join("team-x");
        let checkout = team_dir.join("teamclaw-team");
        std::fs::create_dir_all(&checkout).unwrap();
        std::fs::write(checkout.join("skills.md"), b"keep me").unwrap();
        std::fs::rename(
            base.join("team-secrets").join("team-x.enc"),
            team_dir.join("secrets.enc"),
        )
        .unwrap();

        SecretStore::with_base(base.clone()).load("team-x").unwrap();

        assert!(checkout.join("skills.md").exists());
        assert_eq!(
            std::fs::read(checkout.join("skills.md")).unwrap(),
            b"keep me"
        );
    }

    /// If an earlier run copied the secrets but failed to delete the old file,
    /// a later load must still reap it rather than skip migration forever.
    #[test]
    fn identical_legacy_copy_is_reaped_even_when_current_already_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        let store = SecretStore::with_base(base.clone());
        store
            .save(
                "team-x",
                &TeamSecrets {
                    oss_team_secret: Some("77".repeat(32)),
                    ..Default::default()
                },
            )
            .unwrap();

        // Simulate the copy-succeeded-but-delete-failed state.
        let current = base.join("team-secrets").join("team-x.enc");
        let legacy = base.join("teams").join("team-x").join("secrets.enc");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::copy(&current, &legacy).unwrap();

        store.load("team-x").unwrap();

        assert!(current.exists());
        assert!(
            !legacy.exists(),
            "a leftover identical legacy copy must be reaped on a later load"
        );
    }

    #[test]
    fn migration_is_a_no_op_when_current_secrets_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        let store = SecretStore::with_base(base.clone());
        store
            .save(
                "team-x",
                &TeamSecrets {
                    oss_team_secret: Some("11".repeat(32)),
                    ..Default::default()
                },
            )
            .unwrap();

        // A stale legacy file must not shadow the current one.
        let legacy = base.join("teams").join("team-x").join("secrets.enc");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, b"stale-garbage").unwrap();

        let loaded = store.load("team-x").unwrap();
        assert_eq!(loaded.oss_team_secret, Some("11".repeat(32)));
    }

    #[test]
    fn missing_legacy_and_current_still_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SecretStore::with_base(tmp.path().to_path_buf());
        assert!(store.load("never-seen").unwrap().oss_team_secret.is_none());
    }

    #[test]
    fn clear_removes_both_current_and_legacy_copies() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        let store = SecretStore::with_base(base.clone());
        store
            .save(
                "team-x",
                &TeamSecrets {
                    oss_team_secret: Some("22".repeat(32)),
                    ..Default::default()
                },
            )
            .unwrap();
        let legacy = base.join("teams").join("team-x").join("secrets.enc");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, b"old").unwrap();

        store.clear("team-x").unwrap();

        assert!(!base.join("team-secrets").join("team-x.enc").exists());
        assert!(!legacy.exists(), "clear must not strand the legacy copy");
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

        let file = base.join("team-secrets").join("team-x.enc");
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "team secrets must not be world-readable");

        let dir_mode = std::fs::metadata(base.join("team-secrets"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn migrated_secrets_are_owner_only_even_if_the_legacy_file_was_not() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        let seed = SecretStore::with_base(base.clone());
        seed.save(
            "team-x",
            &TeamSecrets {
                oss_team_secret: Some("44".repeat(32)),
                ..Default::default()
            },
        )
        .unwrap();
        let legacy = base.join("teams").join("team-x").join("secrets.enc");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::rename(base.join("team-secrets").join("team-x.enc"), &legacy).unwrap();
        // The old code path wrote these at the umask default.
        std::fs::set_permissions(&legacy, std::fs::Permissions::from_mode(0o644)).unwrap();

        SecretStore::with_base(base.clone()).load("team-x").unwrap();

        let mode = std::fs::metadata(base.join("team-secrets").join("team-x.enc"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "migration must tighten inherited permissions");
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
