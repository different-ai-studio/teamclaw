use super::super::{BackendError, BackendResult};
use crate::provider_config::CloudApiConfig;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── HTTP helpers ─────────────────────────────────────────────────────────────

pub(super) fn network_error(error: reqwest::Error) -> BackendError {
    BackendError::Provider {
        provider: "cloud_api",
        code: None,
        message: error.to_string(),
    }
}

pub(super) fn request_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(super) fn decode_error(status: StatusCode, envelope: Option<CloudErrorEnvelope>) -> BackendError {
    if status == StatusCode::UNAUTHORIZED {
        return BackendError::Auth(
            envelope
                .map(|e| e.error.message)
                .unwrap_or_else(|| "Cloud API unauthorized".to_string()),
        );
    }
    if status == StatusCode::NOT_FOUND {
        return BackendError::NotFound(
            envelope
                .map(|e| e.error.message)
                .unwrap_or_else(|| "not found".to_string()),
        );
    }
    BackendError::Provider {
        provider: "cloud_api",
        code: envelope.as_ref().and_then(|e| e.error.code.clone()),
        message: envelope
            .map(|e| e.error.message)
            .unwrap_or_else(|| format!("Cloud API request failed with status {status}")),
    }
}

pub(super) async fn decode_response<T>(resp: reqwest::Response) -> BackendResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(network_error)?;
    if status.is_success() {
        return serde_json::from_slice(&bytes).map_err(BackendError::from);
    }
    let envelope = serde_json::from_slice::<CloudErrorEnvelope>(&bytes).ok();
    Err(decode_error(status, envelope))
}

#[derive(Deserialize)]
pub(super) struct CloudErrorEnvelope {
    pub(super) error: CloudErrorBody,
}

#[derive(Deserialize)]
pub(super) struct CloudErrorBody {
    pub(super) code: Option<String>,
    pub(super) message: String,
}

// ── Token ─────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub(super) struct RefreshRequest<'a> {
    #[serde(rename = "refreshToken")]
    pub(super) refresh_token: &'a str,
}

/// Token response from `/v1/auth/refresh` (camelCase).
///
/// Supabase rotates the refresh token on every successful refresh and revokes
/// the prior one after the reuse interval, so the rotated `refreshToken` MUST be
/// captured and persisted — dropping it permanently breaks auth on the next
/// refresh. `expiresAt` (epoch seconds) lets us cache the access token instead
/// of refreshing on every request.
#[derive(Deserialize)]
pub(super) struct TokenResponse {
    #[serde(rename = "accessToken")]
    pub(super) access_token: String,
    #[serde(rename = "refreshToken", default)]
    pub(super) refresh_token: Option<String>,
    #[serde(rename = "expiresAt", default)]
    pub(super) expires_at: Option<i64>,
}

pub(super) fn refresh_failure_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error_description")
                .or_else(|| value.get("msg"))
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| "failed to refresh access token".to_string())
}

// ── Cloud URL helper ───────────────────────────────────────────────────────────

pub(super) fn cloud_url(cfg: &CloudApiConfig, path: &str) -> String {
    format!(
        "{}{}",
        cfg.url.trim_end_matches('/'),
        if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        }
    )
}

pub(super) fn empty_to_none(value: &str) -> Option<&str> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::BackendError;
    use reqwest::StatusCode;

    fn envelope(msg: &str) -> CloudErrorEnvelope {
        CloudErrorEnvelope {
            error: CloudErrorBody {
                code: None,
                message: msg.to_string(),
            },
        }
    }

    fn envelope_with_code(code: &str, msg: &str) -> CloudErrorEnvelope {
        CloudErrorEnvelope {
            error: CloudErrorBody {
                code: Some(code.to_string()),
                message: msg.to_string(),
            },
        }
    }

    #[test]
    fn decode_error_401_with_envelope() {
        let err = decode_error(StatusCode::UNAUTHORIZED, Some(envelope("bad token")));
        assert!(matches!(err, BackendError::Auth(msg) if msg == "bad token"));
    }

    #[test]
    fn decode_error_401_without_envelope() {
        let err = decode_error(StatusCode::UNAUTHORIZED, None);
        assert!(matches!(err, BackendError::Auth(msg) if msg.contains("unauthorized")));
    }

    #[test]
    fn decode_error_404_with_envelope() {
        let err = decode_error(StatusCode::NOT_FOUND, Some(envelope("session not found")));
        assert!(matches!(err, BackendError::NotFound(msg) if msg == "session not found"));
    }

    #[test]
    fn decode_error_404_without_envelope() {
        let err = decode_error(StatusCode::NOT_FOUND, None);
        assert!(matches!(err, BackendError::NotFound(_)));
    }

    #[test]
    fn decode_error_500_with_code() {
        let err = decode_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            Some(envelope_with_code("ERR_DB", "database error")),
        );
        match err {
            BackendError::Provider { provider, code, message } => {
                assert_eq!(provider, "cloud_api");
                assert_eq!(code.as_deref(), Some("ERR_DB"));
                assert_eq!(message, "database error");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn decode_error_500_no_envelope() {
        let err = decode_error(StatusCode::INTERNAL_SERVER_ERROR, None);
        match err {
            BackendError::Provider { message, .. } => {
                assert!(message.contains("500"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn empty_to_none_empty_string() {
        assert_eq!(empty_to_none(""), None);
        assert_eq!(empty_to_none("  "), None);
    }

    #[test]
    fn empty_to_none_nonempty_string() {
        assert_eq!(empty_to_none("hello"), Some("hello"));
    }

    #[test]
    fn cloud_url_trims_trailing_slash() {
        let cfg = crate::provider_config::CloudApiConfig {
            url: "https://cloud.ucar.cc/".to_string(),
            refresh_token: String::new(),
            team_id: "t".to_string(),
            actor_id: "a".to_string(),
        };
        assert_eq!(cloud_url(&cfg, "/v1/foo"), "https://cloud.ucar.cc/v1/foo");
    }

    #[test]
    fn cloud_url_adds_leading_slash() {
        let cfg = crate::provider_config::CloudApiConfig {
            url: "https://cloud.ucar.cc".to_string(),
            refresh_token: String::new(),
            team_id: "t".to_string(),
            actor_id: "a".to_string(),
        };
        assert_eq!(cloud_url(&cfg, "v1/foo"), "https://cloud.ucar.cc/v1/foo");
    }

    #[test]
    fn refresh_failure_message_extracts_error_description() {
        let body = r#"{"error_description":"token expired"}"#;
        assert_eq!(refresh_failure_message(body), "token expired");
    }

    #[test]
    fn refresh_failure_message_fallback_on_garbage() {
        let body = "not json";
        assert_eq!(
            refresh_failure_message(body),
            "failed to refresh access token"
        );
    }

    #[test]
    fn request_id_is_32_hex_chars() {
        let id = request_id();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
