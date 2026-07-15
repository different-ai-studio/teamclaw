use std::env;
use std::path::Path;
use std::sync::Mutex;

static HOME_ENV_LOCK: Mutex<()> = Mutex::new(());

pub fn home_env_lock() -> std::sync::MutexGuard<'static, ()> {
    HOME_ENV_LOCK.lock().unwrap()
}

pub struct HomeGuard {
    previous: Option<String>,
}

impl HomeGuard {
    pub fn set(home: &Path) -> Self {
        let previous = env::var("HOME").ok();
        // SAFETY: test-only; guarded by HOME_ENV_LOCK.
        unsafe {
            env::set_var("HOME", home);
        }
        Self { previous }
    }
}

impl Drop for HomeGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => unsafe {
                env::set_var("HOME", value);
            },
            None => unsafe {
                env::remove_var("HOME");
            },
        }
    }
}
