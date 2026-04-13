//! HS256 JWT device token generation.
//!
//! The generated token is injected into every webview as `window.teamclaw.deviceToken`.
//! The backend (master-data) validates it with the same shared secret before trusting
//! `QueryDeviceSession` / `RegisterDeviceSession` requests.
//!
//! Claims layout (must match `application/infra/util/jwt.go` on the backend):
//!   sub      – device_id (unique device identifier)
//!   team_id  – team / workspace (optional, reserved)
//!   aud      – "master-data-api"
//!   iat      – issued-at (Unix seconds)
//!   exp      – iat + TOKEN_TTL_SECS
//!   jti      – UUID v4, consumed by Redis SetNX for replay prevention

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

/// JWT secret embedded at compile time from `build.config.json → device.jwtSecret`.
/// Must match the value in `masterdata_config.toml → [DeviceSessionConfig] jwt_secret`.
const DEVICE_JWT_SECRET: &str = env!("DEVICE_JWT_SECRET");

/// Token lifetime in seconds (90 s, within the 60-120 s window specified in the proto).
const TOKEN_TTL_SECS: i64 = 90;

/// Generate a fresh short-lived HS256 JWT for the given device.
///
/// Each call produces a different token because `iat`, `exp`, and `jti` change.
/// Returns `Err` if the secret is not configured or if a system-time error occurs.
pub fn generate(device_id: &str, team_id: &str) -> Result<String, String> {
    generate_with_secret(device_id, team_id, DEVICE_JWT_SECRET)
}

/// Tauri command: generate a fresh device JWT on demand.
///
/// The frontend should call this before every API request that requires a
/// device token, instead of reusing the token injected at webview creation
/// time (which expires after 90 s and never refreshes on page reload).
///
/// Usage from JS:
///   const token = await window.__TAURI__.core.invoke('generate_device_token');
#[tauri::command]
pub fn generate_device_token() -> Result<String, String> {
    let device_id = super::oss_commands::get_persistent_device_id()?;
    generate(&device_id, "")
}

/// Same as [`generate`] but accepts an explicit secret — useful for tests.
pub fn generate_with_secret(
    device_id: &str,
    team_id: &str,
    secret: &str,
) -> Result<String, String> {
    if secret.is_empty() {
        return Err(
            "DEVICE_JWT_SECRET is not configured. Set device.jwtSecret in build.config.local.json"
                .to_string(),
        );
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("System time error: {}", e))?
        .as_secs() as i64;

    // Header (fixed for HS256)
    let encoded_header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);

    // Payload
    let payload = serde_json::json!({
        "sub":     device_id,
        "team_id": team_id,
        "aud":     "master-data-api",
        "iat":     now,
        "exp":     now + TOKEN_TTL_SECS,
        "jti":     Uuid::new_v4().to_string(),
    });
    let encoded_payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_string(&payload)
            .map_err(|e| format!("Payload serialisation error: {}", e))?,
    );

    // Signature: HMAC-SHA256(header.payload, secret)
    let signing_input = format!("{}.{}", encoded_header, encoded_payload);
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|e| format!("HMAC init error: {}", e))?;
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    Ok(format!("{}.{}", signing_input, signature))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_and_structure() {
        let token = generate_with_secret("device-abc", "team-xyz", "test-secret").unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT must have exactly 3 parts");

        // Decode payload
        let payload_json = URL_SAFE_NO_PAD
            .decode(parts[1])
            .expect("base64url decode failed");
        let payload: serde_json::Value =
            serde_json::from_slice(&payload_json).expect("JSON parse failed");

        assert_eq!(payload["sub"], "device-abc");
        assert_eq!(payload["team_id"], "team-xyz");
        assert_eq!(payload["aud"], "master-data-api");
        assert!(payload["iat"].as_i64().unwrap() > 0);
        assert!(payload["exp"].as_i64().unwrap() > payload["iat"].as_i64().unwrap());
        assert!(!payload["jti"].as_str().unwrap().is_empty());
    }

    #[test]
    fn test_empty_secret_returns_error() {
        let result = generate_with_secret("device-abc", "", "");
        assert!(result.is_err());
    }

    #[test]
    fn test_each_call_produces_unique_jti() {
        let t1 = generate_with_secret("d", "", "secret").unwrap();
        // Small sleep to ensure iat differs; jti is UUID so it's always unique anyway.
        let t2 = generate_with_secret("d", "", "secret").unwrap();
        assert_ne!(t1, t2, "Two tokens must never be identical");
    }
}
