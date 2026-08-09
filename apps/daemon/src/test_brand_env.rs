//! Serialize tests that mutate brand / amuxd-home path env vars.
//!
//! Shares `TEST_HOME_LOCK` with the tests that mutate `HOME` rather than
//! keeping a second mutex. Both sets drive the *same* process-global path
//! resolution — `HOME`, `AMUXD_HOME` and the brand name all feed
//! `global_team_dir()` / `config_dir()` — so two independent locks serialized
//! each set against itself while leaving them free to race against each other.
//! That race is what made `team_link` / `workspace_link` / `daemon::server`
//! tests fail under `cargo test` but pass under `--test-threads=1`.

use std::path::Path;
use std::sync::MutexGuard;

use crate::config::global_team_store::TEST_HOME_LOCK;

pub struct BrandEnvGuard {
    _lock: MutexGuard<'static, ()>,
    previous_brand: Option<String>,
    previous_home: Option<String>,
}

impl BrandEnvGuard {
    /// Set `TEAMCLU_BRAND_SHORT_NAME` and clear `AMUXD_HOME` so path resolution
    /// is driven by brand alone.
    pub fn set(brand: &str) -> Self {
        let lock = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous_brand = std::env::var(teamclu_runtime_env::BRAND_SHORT_NAME_ENV).ok();
        let previous_home = std::env::var(teamclu_runtime_env::AMUXD_HOME_ENV).ok();
        std::env::set_var(teamclu_runtime_env::BRAND_SHORT_NAME_ENV, brand);
        std::env::remove_var(teamclu_runtime_env::AMUXD_HOME_ENV);
        Self {
            _lock: lock,
            previous_brand,
            previous_home,
        }
    }

    /// Set an explicit `AMUXD_HOME` override (brand env left unchanged).
    pub fn set_amuxd_home(home: &Path) -> Self {
        let lock = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous_brand = std::env::var(teamclu_runtime_env::BRAND_SHORT_NAME_ENV).ok();
        let previous_home = std::env::var(teamclu_runtime_env::AMUXD_HOME_ENV).ok();
        std::env::set_var(teamclu_runtime_env::AMUXD_HOME_ENV, home);
        Self {
            _lock: lock,
            previous_brand,
            previous_home,
        }
    }
}

impl Drop for BrandEnvGuard {
    fn drop(&mut self) {
        match &self.previous_brand {
            Some(v) => std::env::set_var(teamclu_runtime_env::BRAND_SHORT_NAME_ENV, v),
            None => std::env::remove_var(teamclu_runtime_env::BRAND_SHORT_NAME_ENV),
        }
        match &self.previous_home {
            Some(v) => std::env::set_var(teamclu_runtime_env::AMUXD_HOME_ENV, v),
            None => std::env::remove_var(teamclu_runtime_env::AMUXD_HOME_ENV),
        }
    }
}
