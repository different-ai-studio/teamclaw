//! Root + session token storage.
//!
//! - **Root token**: generated on first daemon start, written to
//!   `<config_dir>/amuxd.http.token` with mode 0600. Anyone who can read
//!   that file can mint short-lived session tokens; protecting it is left
//!   to filesystem permissions.
//! - **Session token**: short-lived, scope-bounded, in-memory only.
//!   Re-creating the daemon process invalidates all session tokens.
//!
//! Both tokens are compared with [`subtle::ConstantTimeEq`] to keep timing
//! channels closed.

use parking_lot::RwLock;
use rand::RngCore;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use subtle::ConstantTimeEq;
use uuid::Uuid;

/// 256-bit random token, base64url-encoded without padding (43 chars).
fn random_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    base64_url_no_pad(&buf)
}

fn base64_url_no_pad(input: &[u8]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(input)
}

/// In-memory session token record.
#[derive(Debug, Clone)]
pub struct SessionTokenInfo {
    pub token_id: Uuid,
    pub scopes: Vec<String>,
    pub expires_at: SystemTime,
    pub label: Option<String>,
    pub created_at: SystemTime,
}

/// Public projection used by `/v1/auth/tokens` responses; never includes
/// the raw token material.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionTokenSummary {
    pub token_id: Uuid,
    pub scopes: Vec<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub label: Option<String>,
}

impl From<&SessionTokenInfo> for SessionTokenSummary {
    fn from(s: &SessionTokenInfo) -> Self {
        Self {
            token_id: s.token_id,
            scopes: s.scopes.clone(),
            created_at: chrono::DateTime::<chrono::Utc>::from(s.created_at),
            expires_at: chrono::DateTime::<chrono::Utc>::from(s.expires_at),
            label: s.label.clone(),
        }
    }
}

/// Thread-safe token store. `Arc`-cloneable for sharing across handler
/// tasks. The root token is fixed for the daemon's lifetime; session
/// tokens come and go.
#[derive(Clone)]
pub struct TokenStore {
    inner: Arc<TokenStoreInner>,
}

struct TokenStoreInner {
    root: String,
    sessions: RwLock<HashMap<String, SessionTokenInfo>>,
    by_id: RwLock<HashMap<Uuid, String>>,
}

impl TokenStore {
    /// Load (or generate + persist) the root token from `path`. The file
    /// is created with mode 0600 on first run.
    pub fn load_or_init(path: &Path) -> std::io::Result<Self> {
        let root = if path.exists() {
            std::fs::read_to_string(path)?.trim().to_string()
        } else {
            let token = random_token();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            write_private_file(path, token.as_bytes())?;
            token
        };
        if root.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("token file {} is empty", path.display()),
            ));
        }
        Ok(Self {
            inner: Arc::new(TokenStoreInner {
                root,
                sessions: RwLock::new(HashMap::new()),
                by_id: RwLock::new(HashMap::new()),
            }),
        })
    }

    /// Constant-time root-token check.
    pub fn verify_root(&self, candidate: &str) -> bool {
        ct_eq_str(&self.inner.root, candidate)
    }

    /// Mint a new session token. Caller must already have proven they hold
    /// the root token. Returns `(raw_token, info)`.
    pub fn mint(
        &self,
        scopes: Vec<String>,
        ttl: Duration,
        label: Option<String>,
    ) -> (String, SessionTokenInfo) {
        let raw = random_token();
        let info = SessionTokenInfo {
            token_id: Uuid::new_v4(),
            scopes,
            expires_at: SystemTime::now() + ttl,
            label,
            created_at: SystemTime::now(),
        };
        self.inner.by_id.write().insert(info.token_id, raw.clone());
        self.inner
            .sessions
            .write()
            .insert(raw.clone(), info.clone());
        (raw, info)
    }

    /// Look up a session token, validating its expiry. Returns `None`
    /// when unknown or expired (and evicts expired entries lazily).
    pub fn lookup(&self, raw: &str) -> Option<SessionTokenInfo> {
        // Lookup is by exact key; ConstantTimeEq isn't applicable to map
        // probing without iterating, but the keys come from our own RNG so
        // brute force isn't realistic with 256-bit entropy.
        let info = self.inner.sessions.read().get(raw).cloned()?;
        if info.expires_at <= SystemTime::now() {
            self.revoke_by_token(raw);
            return None;
        }
        Some(info)
    }

    pub fn revoke(&self, token_id: Uuid) -> bool {
        let raw = self.inner.by_id.write().remove(&token_id);
        if let Some(raw) = raw {
            self.inner.sessions.write().remove(&raw);
            true
        } else {
            false
        }
    }

    pub fn revoke_by_token(&self, raw: &str) -> bool {
        if let Some(info) = self.inner.sessions.write().remove(raw) {
            self.inner.by_id.write().remove(&info.token_id);
            true
        } else {
            false
        }
    }

    pub fn list(&self) -> Vec<SessionTokenInfo> {
        self.inner.sessions.read().values().cloned().collect()
    }

    /// Drop expired entries. Called by the periodic reaper.
    pub fn sweep_expired(&self) -> usize {
        let now = SystemTime::now();
        let mut sessions = self.inner.sessions.write();
        let mut by_id = self.inner.by_id.write();
        let before = sessions.len();
        sessions.retain(|_, info| {
            if info.expires_at > now {
                true
            } else {
                by_id.remove(&info.token_id);
                false
            }
        });
        before - sessions.len()
    }
}

fn ct_eq_str(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// Write `content` to `path` with mode 0600 on unix. Replaces any existing
/// file atomically by writing to a tempfile and renaming.
fn write_private_file(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write as _;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(content)?;
        f.flush()?;
    }
    std::fs::rename(&tmp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, perms)?;
    }
    Ok(())
}

/// Write the actually-bound port to `port_file`. Best-effort — failure to
/// write is logged but does not abort daemon startup.
pub fn write_port_file(port_file: &Path, port: u16) {
    let payload = format!("{port}\n");
    if let Err(e) = std::fs::create_dir_all(port_file.parent().unwrap_or(Path::new("."))) {
        tracing::warn!("create port_file parent failed: {e}");
        return;
    }
    if let Err(e) = std::fs::write(port_file, payload) {
        tracing::warn!("write port_file {} failed: {e}", port_file.display());
    }
}

/// Re-export so callers don't depend on `PathBuf` here directly.
#[allow(dead_code)]
pub type TokenPath = PathBuf;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn root_token_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("token");
        let store = TokenStore::load_or_init(&path).unwrap();
        assert!(path.exists());
        let raw = std::fs::read_to_string(&path).unwrap();
        let trimmed = raw.trim();
        assert!(store.verify_root(trimmed));
        assert!(!store.verify_root("wrong"));
        // Idempotent: second load reuses the same token.
        let store2 = TokenStore::load_or_init(&path).unwrap();
        assert!(store2.verify_root(trimmed));
    }

    #[test]
    fn mint_lookup_revoke() {
        let dir = tempdir().unwrap();
        let store = TokenStore::load_or_init(&dir.path().join("t")).unwrap();
        let (raw, info) = store.mint(
            vec!["sessions:read".into()],
            Duration::from_secs(60),
            Some("test".into()),
        );
        let looked = store.lookup(&raw).unwrap();
        assert_eq!(looked.token_id, info.token_id);
        assert!(store.revoke(info.token_id));
        assert!(store.lookup(&raw).is_none());
    }

    #[test]
    fn expired_session_evicted_on_lookup() {
        let dir = tempdir().unwrap();
        let store = TokenStore::load_or_init(&dir.path().join("t")).unwrap();
        let (raw, _) = store.mint(vec![], Duration::from_millis(1), None);
        std::thread::sleep(Duration::from_millis(10));
        assert!(store.lookup(&raw).is_none());
    }
}
