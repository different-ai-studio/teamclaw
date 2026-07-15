use std::fs;
use std::path::PathBuf;

/// Telemetry-only per-install id (NOT a routing identity). Persisted so two
/// machines running amuxd for the same actor show as separate version rows.
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
