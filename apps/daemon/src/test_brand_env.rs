//! Serialize tests that mutate brand / amuxd-home path env vars.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

static BRAND_ENV_LOCK: Mutex<()> = Mutex::new(());

pub struct BrandEnvGuard {
    _lock: MutexGuard<'static, ()>,
    previous_brand: Option<String>,
    previous_home: Option<String>,
}

impl BrandEnvGuard {
    /// Set `TEAMCLAW_BRAND_SHORT_NAME` and clear `AMUXD_HOME` so path resolution
    /// is driven by brand alone.
    pub fn set(brand: &str) -> Self {
        let lock = BRAND_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous_brand = std::env::var(teamclaw_runtime_env::BRAND_SHORT_NAME_ENV).ok();
        let previous_home = std::env::var(teamclaw_runtime_env::AMUXD_HOME_ENV).ok();
        std::env::set_var(teamclaw_runtime_env::BRAND_SHORT_NAME_ENV, brand);
        std::env::remove_var(teamclaw_runtime_env::AMUXD_HOME_ENV);
        Self {
            _lock: lock,
            previous_brand,
            previous_home,
        }
    }

    /// Set an explicit `AMUXD_HOME` override (brand env left unchanged).
    pub fn set_amuxd_home(home: &Path) -> Self {
        let lock = BRAND_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous_brand = std::env::var(teamclaw_runtime_env::BRAND_SHORT_NAME_ENV).ok();
        let previous_home = std::env::var(teamclaw_runtime_env::AMUXD_HOME_ENV).ok();
        std::env::set_var(teamclaw_runtime_env::AMUXD_HOME_ENV, home);
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
            Some(v) => std::env::set_var(teamclaw_runtime_env::BRAND_SHORT_NAME_ENV, v),
            None => std::env::remove_var(teamclaw_runtime_env::BRAND_SHORT_NAME_ENV),
        }
        match &self.previous_home {
            Some(v) => std::env::set_var(teamclaw_runtime_env::AMUXD_HOME_ENV, v),
            None => std::env::remove_var(teamclaw_runtime_env::AMUXD_HOME_ENV),
        }
    }
}
