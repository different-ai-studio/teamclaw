use std::path::Path;

use serde_json::{json, Value};
use teamclaw_runtime_env::{read_active_session_id, TEAMCLAW_SESSION_ID_ENV};

const DEFAULT_SCHEME: &str = "teamclaw";

/// Validate a UUID v4-style session id (same rules as `session-deeplink.ts`).
fn validate_session_id(session_id: &str) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("session_id is required".to_string());
    }

    let parts: Vec<&str> = id.split('-').collect();
    if parts.len() != 5 {
        return Err(format!("Invalid session_id (expected UUID): {id}"));
    }

    let expected_lens = [8, 4, 4, 4, 12];
    for (part, len) in parts.iter().zip(expected_lens) {
        if part.len() != len || !part.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("Invalid session_id (expected UUID): {id}"));
        }
    }

    Ok(())
}

fn resolve_scheme(arguments: &Value) -> Result<String, String> {
    let scheme = arguments
        .get("scheme")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("TEAMCLAW_APP_SCHEME").ok())
        .unwrap_or_else(|| DEFAULT_SCHEME.to_string());

    if !scheme
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        return Err(format!("Invalid scheme: {scheme}"));
    }

    Ok(scheme)
}

fn resolve_session_id(workspace: &str, arguments: &Value) -> Result<String, String> {
    if let Some(id) = arguments
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        validate_session_id(id)?;
        return Ok(id.to_string());
    }

    if let Ok(id) = std::env::var(TEAMCLAW_SESSION_ID_ENV) {
        let id = id.trim();
        if !id.is_empty() {
            validate_session_id(id)?;
            return Ok(id.to_string());
        }
    }

    if let Some(id) = read_active_session_id(Path::new(workspace)) {
        validate_session_id(&id)?;
        return Ok(id);
    }

    Err(
        "session_id is required: pass session_id, set TEAMCLAW_SESSION_ID, or run inside an active TeamClaw session"
            .to_string(),
    )
}

pub fn build_session_deeplink(session_id: &str, scheme: &str) -> String {
    format!("{scheme}://session/{session_id}")
}

pub fn handle(workspace: &str, arguments: &Value) -> Result<Value, String> {
    let session_id = resolve_session_id(workspace, arguments)?;
    let scheme = resolve_scheme(arguments)?;
    let deeplink = build_session_deeplink(&session_id, &scheme);

    Ok(json!({
        "session_id": session_id,
        "scheme": scheme,
        "deeplink": deeplink,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use teamclaw_runtime_env::write_active_session_id;

    static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    const UUID: &str = "a1ca8f06-94ee-4fb5-bdfb-194a5606062f";

    #[test]
    fn build_session_deeplink_uses_teamclaw_scheme_by_default() {
        assert_eq!(
            build_session_deeplink(UUID, "teamclaw"),
            format!("teamclaw://session/{UUID}")
        );
    }

    #[test]
    fn handle_returns_deeplink_for_valid_uuid() {
        let result = handle("/ws", &json!({ "session_id": UUID })).unwrap();
        assert_eq!(result["deeplink"], format!("teamclaw://session/{UUID}"));
        assert_eq!(result["session_id"], UUID);
        assert_eq!(result["scheme"], "teamclaw");
    }

    #[test]
    fn handle_accepts_custom_scheme() {
        let result = handle("/ws", &json!({ "session_id": UUID, "scheme": "acme" })).unwrap();
        assert_eq!(result["deeplink"], format!("acme://session/{UUID}"));
    }

    #[test]
    fn handle_rejects_invalid_uuid() {
        let err = handle("/ws", &json!({ "session_id": "not-a-uuid" })).unwrap_err();
        assert!(err.contains("Invalid session_id"));
    }

    #[test]
    fn handle_requires_session_id_when_unresolved() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let prev = std::env::var(TEAMCLAW_SESSION_ID_ENV).ok();
        std::env::remove_var(TEAMCLAW_SESSION_ID_ENV);
        let err = handle("/ws", &json!({})).unwrap_err();
        assert!(err.contains("session_id is required"));
        match prev {
            Some(v) => std::env::set_var(TEAMCLAW_SESSION_ID_ENV, v),
            None => std::env::remove_var(TEAMCLAW_SESSION_ID_ENV),
        }
    }

    #[test]
    fn handle_reads_active_session_id_file() {
        let dir = tempfile::tempdir().unwrap();
        write_active_session_id(dir.path(), UUID).unwrap();
        let result = handle(dir.path().to_str().unwrap(), &json!({})).unwrap();
        assert_eq!(result["session_id"], UUID);
    }

    #[test]
    fn handle_reads_teamclaw_session_id_env() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        let prev = std::env::var(TEAMCLAW_SESSION_ID_ENV).ok();
        std::env::set_var(TEAMCLAW_SESSION_ID_ENV, UUID);
        let result = handle("/ws", &json!({})).unwrap();
        assert_eq!(result["session_id"], UUID);
        match prev {
            Some(v) => std::env::set_var(TEAMCLAW_SESSION_ID_ENV, v),
            None => std::env::remove_var(TEAMCLAW_SESSION_ID_ENV),
        }
    }
}
