use serde_json::{json, Value};

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

pub fn build_session_deeplink(session_id: &str, scheme: &str) -> String {
    format!("{scheme}://session/{session_id}")
}

pub fn handle(arguments: &Value) -> Result<Value, String> {
    let session_id = arguments
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .ok_or_else(|| "Missing field: session_id".to_string())?;

    validate_session_id(session_id)?;
    let scheme = resolve_scheme(arguments)?;
    let deeplink = build_session_deeplink(session_id, &scheme);

    Ok(json!({
        "session_id": session_id,
        "scheme": scheme,
        "deeplink": deeplink,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let result = handle(&json!({ "session_id": UUID })).unwrap();
        assert_eq!(result["deeplink"], format!("teamclaw://session/{UUID}"));
        assert_eq!(result["session_id"], UUID);
        assert_eq!(result["scheme"], "teamclaw");
    }

    #[test]
    fn handle_accepts_custom_scheme() {
        let result = handle(&json!({ "session_id": UUID, "scheme": "acme" })).unwrap();
        assert_eq!(result["deeplink"], format!("acme://session/{UUID}"));
    }

    #[test]
    fn handle_rejects_invalid_uuid() {
        let err = handle(&json!({ "session_id": "not-a-uuid" })).unwrap_err();
        assert!(err.contains("Invalid session_id"));
    }

    #[test]
    fn handle_requires_session_id() {
        let err = handle(&json!({})).unwrap_err();
        assert!(err.contains("session_id"));
    }
}
