use std::fs;
use std::path::PathBuf;

/// This machine's stable id. Persisted at `~/.amuxd/device-id`, generated once.
///
/// Two roles, and the second one is why it must stay stable: it separates two
/// machines' rows in client-version telemetry, AND it is the key the Cloud API
/// binds an agent actor to (`agents.device_id`, unique per team). A rotated id
/// means the next login silently provisions a second agent for this machine, so
/// nothing may regenerate this file — note that `amuxd clear` deliberately does
/// not remove it.
///
/// Not to be confused with the webview's `teamclu.client-version.device-id`,
/// which lives in local storage and is telemetry-only.
pub fn daemon_device_id() -> String {
    let path = device_id_path();
    if let Some(p) = &path {
        if let Ok(existing) = fs::read_to_string(p) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(p, &id);
        return id;
    }
    uuid::Uuid::new_v4().to_string()
}

fn device_id_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".amuxd").join("device-id"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn returns_nonempty_stable_id() {
        let a = super::daemon_device_id();
        let b = super::daemon_device_id();
        assert!(!a.is_empty());
        assert_eq!(a, b, "device id must be stable across calls");
    }
}
