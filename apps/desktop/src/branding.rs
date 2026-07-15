//! Compile-time white-label helpers. The brand name comes from the Tauri
//! config `productName` (written at build time by scripts/update-tauri-config.js
//! from build.config `app.name`), falling back to "TeamClaw".

/// Resolve the brand display name from an optional configured product name.
pub fn brand_name(configured: Option<&str>) -> String {
    configured
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("TeamClaw")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_when_none() {
        assert_eq!(brand_name(None), "TeamClaw");
    }

    #[test]
    fn falls_back_when_empty() {
        assert_eq!(brand_name(Some("")), "TeamClaw");
        assert_eq!(brand_name(Some("   ")), "TeamClaw");
    }

    #[test]
    fn uses_configured_name() {
        assert_eq!(brand_name(Some("Acme")), "Acme");
        assert_eq!(brand_name(Some("  Acme  ")), "Acme");
    }
}
