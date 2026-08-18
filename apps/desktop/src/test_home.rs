//! Serialize tests that touch the process-global `HOME`.
//!
//! Four separate `HomeGuard`s used to live in this crate — in `opencode_paths`,
//! `commands::{clawhub, env_vars, shared_secrets}` — and only one of them took a
//! lock. So a test that set `HOME` to a temp dir raced against every other test
//! that read it, and two of the guards *deleted* `HOME` on drop instead of
//! restoring it. That is what made `deps::probe_program_resolves_opencode_
//! absolute_when_present` fail under `cargo test` and pass under
//! `--test-threads=1`: it computed its expectation and called the code under test
//! either side of somebody else's `set_var`. The same race surfaced in
//! `env_vars` as a missing `master.key` followed by a `PoisonError` cascade.
//!
//! One lock, one guard, and it restores the previous value. Mirrors the daemon's
//! `test_brand_env` (same reasoning, same shape).

use std::ffi::OsString;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

fn home_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Holds the `HOME` lock for the life of the guard, and restores whatever `HOME`
/// was when it drops. A poisoned lock is recovered rather than propagated: one
/// failing test must not turn every later one into a `PoisonError`.
pub struct HomeGuard {
    _lock: MutexGuard<'static, ()>,
    previous: Option<OsString>,
}

impl HomeGuard {
    /// Point `HOME` at `path` for the life of the guard.
    pub fn set(path: &Path) -> Self {
        let guard = Self::observe();
        std::env::set_var("HOME", path);
        guard
    }

    /// Take the lock without changing `HOME` — for a test that only *reads* it
    /// and must not have it moved mid-test.
    pub fn observe() -> Self {
        let lock = home_lock().lock().unwrap_or_else(|e| e.into_inner());
        Self {
            _lock: lock,
            previous: std::env::var_os("HOME"),
        }
    }
}

impl Drop for HomeGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
    }
}
