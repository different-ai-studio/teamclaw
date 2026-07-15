//! Background maintenance of the cloud access-token file.
//!
//! The daemon writes the current cloud access token (a short-lived JWT, ~1h
//! TTL) to a `0600` file and keeps it refreshed just before each expiry. Agent
//! processes receive the *path* to this file via `TC_ACCESS_TOKEN_FILE` (never
//! the token itself), so a session that runs for days can always re-read a
//! fresh token — env values, by contrast, are frozen at spawn and would go
//! stale within the hour.
//!
//! Only cloud backends drive this: the spawner and the env-injection path are
//! both gated on `Backend::cloud_auth_health()` being `Some`, so the file
//! exists whenever its path is advertised.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::backend::{epoch_secs_now, Backend};

/// Refresh this many seconds before the token's wall-clock expiry so the file
/// is never handed out already-expired.
const REFRESH_BUFFER_SECS: i64 = 120;
/// Floor on the sleep between refreshes — avoids a hot loop if expiry is very
/// near (or in the past) right after a refresh.
const MIN_SLEEP: Duration = Duration::from_secs(30);
/// Ceiling on the sleep — bounds staleness if an impl reports a far-future (or
/// missing) expiry, and forces a periodic re-write even for long-lived tokens.
const MAX_SLEEP: Duration = Duration::from_secs(1800);
/// Backoff after a failed refresh before retrying.
const RETRY_SLEEP: Duration = Duration::from_secs(30);

/// Spawn the long-lived refresher task. Writes the token once immediately, then
/// loops: refresh → write → sleep until just before the next expiry.
pub(crate) fn spawn(backend: Arc<dyn Backend>, path: PathBuf) {
    tokio::spawn(async move {
        loop {
            match backend.auth_token().await {
                Ok(token) => {
                    if let Err(e) = write_token_file(&path, &token) {
                        tracing::warn!(
                            path = %path.display(),
                            error = %e,
                            "cloud-token file write failed"
                        );
                    }
                    let delay = next_refresh_delay(backend.cached_credential_expiry_epoch());
                    tokio::time::sleep(delay).await;
                }
                Err(e) => {
                    tracing::warn!(error = %e, "cloud-token refresh failed; will retry");
                    tokio::time::sleep(RETRY_SLEEP).await;
                }
            }
        }
    });
}

/// How long to wait before the next refresh, from the token's expiry epoch.
/// Clamped to `[MIN_SLEEP, MAX_SLEEP]`; a missing expiry falls back to
/// `MAX_SLEEP` so the file is still rewritten periodically.
fn next_refresh_delay(expires_at_epoch: Option<i64>) -> Duration {
    match expires_at_epoch {
        Some(expiry) => {
            let secs_until_refresh = expiry - REFRESH_BUFFER_SECS - epoch_secs_now();
            let clamped = secs_until_refresh
                .max(MIN_SLEEP.as_secs() as i64)
                .min(MAX_SLEEP.as_secs() as i64);
            Duration::from_secs(clamped as u64)
        }
        None => MAX_SLEEP,
    }
}

/// Atomically write `token` to `path` with `0600` perms (owner-only). Writes to
/// a sibling temp file and renames so a concurrent reader never sees a partial
/// token.
fn write_token_file(path: &Path, token: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, token.as_bytes())?;
    set_owner_only(&tmp)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> std::io::Result<()> {
    // Windows loopback + per-user profile dir is the trust boundary here; no
    // POSIX mode to set.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_clamps_near_expiry_to_min() {
        // Expiry already in the past → floor at MIN_SLEEP, never negative.
        let d = next_refresh_delay(Some(epoch_secs_now() - 10));
        assert_eq!(d, MIN_SLEEP);
    }

    #[test]
    fn delay_clamps_far_expiry_to_max() {
        let d = next_refresh_delay(Some(epoch_secs_now() + 100_000));
        assert_eq!(d, MAX_SLEEP);
    }

    #[test]
    fn delay_uses_buffer_before_expiry() {
        // Expiry ~10min out → refresh ~(600 - 120)s from now, within bounds.
        let d = next_refresh_delay(Some(epoch_secs_now() + 600));
        assert!(d >= MIN_SLEEP && d <= MAX_SLEEP);
        assert!(d.as_secs() <= 600 - REFRESH_BUFFER_SECS as u64);
    }

    #[test]
    fn missing_expiry_falls_back_to_max() {
        assert_eq!(next_refresh_delay(None), MAX_SLEEP);
    }

    #[test]
    fn write_is_atomic_and_owner_only() {
        let dir = std::env::temp_dir().join(format!("amuxd-cloud-token-test-{}", std::process::id()));
        let path = dir.join("amuxd.cloud-token");
        write_token_file(&path, "jwt-abc").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "jwt-abc");
        // Overwrite works (rename over existing).
        write_token_file(&path, "jwt-def").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "jwt-def");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
