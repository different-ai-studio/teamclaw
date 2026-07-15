//! Bearer-token authentication for the HTTP API.
//!
//! Two distinct credentials flow through here:
//!
//! - **Root token**: read from `amuxd.http.token`. Authorises only the
//!   `/v1/auth/*` namespace — it can mint session tokens but cannot drive
//!   sessions itself. This keeps long-lived high-privilege material out
//!   of normal request paths.
//! - **Session token**: minted by [`exchange_handler`]. Carries a list of
//!   scopes (`sessions:read`, `sessions:write`, `events:read`, …) and an
//!   expiry. Required for everything outside `/v1/auth/*` and
//!   `/v1/healthz` / `/v1/info`.
//!
//! Tokens are accepted via `Authorization: Bearer <token>` for normal
//! requests, or `?access_token=<token>` for SSE (since `EventSource`
//! cannot send custom headers). Both paths use the same constant-time
//! lookup.

use axum::{
    extract::{Query, State},
    Json,
};
use http::header;
use http::request::Parts;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;

use super::errors::HttpError;
use super::state::HttpState;
use super::tokens::{SessionTokenInfo, SessionTokenSummary};

/// Scope check helper — call from handlers that need a specific
/// capability. Returns 403 when the bound token doesn't carry the scope.
pub fn require_scope(principal: &Principal, scope: &str) -> Result<(), HttpError> {
    if principal.scopes.iter().any(|s| s == scope) {
        Ok(())
    } else {
        Err(HttpError::forbidden(format!(
            "missing required scope: {scope}"
        )))
    }
}

/// Result of a successful Bearer-token check. The handler can inspect
/// `token_id` / `scopes` directly or use [`require_scope`].
#[derive(Debug, Clone)]
pub struct Principal {
    pub token_id: Uuid,
    pub scopes: Vec<String>,
}

impl From<SessionTokenInfo> for Principal {
    fn from(s: SessionTokenInfo) -> Self {
        Self {
            token_id: s.token_id,
            scopes: s.scopes,
        }
    }
}

/// Axum extractor for [`Principal`]. Pulls the bearer token from
/// `Authorization: Bearer …` or, when missing, `?access_token=…` (used
/// by SSE).
#[axum::async_trait]
impl<S> axum::extract::FromRequestParts<S> for Principal
where
    HttpState: axum::extract::FromRef<S>,
    S: Send + Sync,
{
    type Rejection = HttpError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let http_state = <HttpState as axum::extract::FromRef<S>>::from_ref(state);
        let token = extract_bearer(parts)?;
        let info = http_state
            .tokens
            .lookup(&token)
            .ok_or_else(|| HttpError::unauthorized("invalid or expired token"))?;
        Ok(Principal::from(info))
    }
}

/// Axum extractor for the *root* token. Used only on `/v1/auth/*`.
pub struct RootAuth;

#[axum::async_trait]
impl<S> axum::extract::FromRequestParts<S> for RootAuth
where
    HttpState: axum::extract::FromRef<S>,
    S: Send + Sync,
{
    type Rejection = HttpError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let http_state = <HttpState as axum::extract::FromRef<S>>::from_ref(state);
        let token = extract_bearer(parts)?;
        if !http_state.tokens.verify_root(&token) {
            return Err(HttpError::unauthorized("invalid root token"));
        }
        Ok(RootAuth)
    }
}

fn extract_bearer(parts: &Parts) -> Result<String, HttpError> {
    if let Some(value) = parts.headers.get(header::AUTHORIZATION) {
        let raw = value
            .to_str()
            .map_err(|_| HttpError::unauthorized("authorization header not ascii"))?;
        if let Some(token) = raw.strip_prefix("Bearer ") {
            return Ok(token.trim().to_owned());
        }
        return Err(HttpError::unauthorized(
            "authorization header must use Bearer scheme",
        ));
    }
    // Query fallback for SSE — EventSource cannot set headers.
    if let Some(query) = parts.uri.query() {
        for pair in query.split('&') {
            if let Some(v) = pair.strip_prefix("access_token=") {
                if !v.is_empty() {
                    return Ok(percent_decode(v));
                }
            }
        }
    }
    Err(HttpError::unauthorized("missing bearer token"))
}

fn percent_decode(s: &str) -> String {
    // Tokens are base64url and don't legally contain percent escapes, but
    // browsers may still encode the `=` padding. Keep this tiny and
    // dependency-free; full URL decoding is unnecessary.
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(h1), Some(h2)) = (h1, h2) {
                if let Ok(byte) = u8::from_str_radix(&format!("{h1}{h2}"), 16) {
                    out.push(byte as char);
                    continue;
                }
            }
            // malformed escape — keep literal
            out.push('%');
            if let Some(h1) = h1 {
                out.push(h1);
            }
            if let Some(h2) = h2 {
                out.push(h2);
            }
        } else if c == '+' {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

// ── Handlers ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ExchangeRequest {
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ExchangeResponse {
    pub token: String,
    pub token_id: Uuid,
    pub scopes: Vec<String>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

pub async fn exchange_handler(
    _root: RootAuth,
    State(state): State<HttpState>,
    Json(req): Json<ExchangeRequest>,
) -> Result<Json<ExchangeResponse>, HttpError> {
    let scopes = req
        .scopes
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| state.config.default_scopes.clone());

    validate_scopes(&scopes)?;

    let ttl_secs = req.ttl_seconds.unwrap_or(3600);
    if ttl_secs == 0 || ttl_secs > 86_400 {
        return Err(HttpError::validation(
            "ttl_seconds must be between 1 and 86400",
        ));
    }

    if let Some(label) = req.label.as_deref() {
        if label.len() > 128 {
            return Err(HttpError::validation("label too long (max 128 chars)"));
        }
    }

    let (raw, info) = state
        .tokens
        .mint(scopes.clone(), Duration::from_secs(ttl_secs), req.label);

    Ok(Json(ExchangeResponse {
        token: raw,
        token_id: info.token_id,
        scopes,
        expires_at: chrono::DateTime::<chrono::Utc>::from(info.expires_at),
    }))
}

fn validate_scopes(scopes: &[String]) -> Result<(), HttpError> {
    const ALLOWED: &[&str] = &[
        "sessions:read",
        "sessions:write",
        "events:read",
        "workspace:read",
        "workspace:write",
        "admin",
    ];
    for s in scopes {
        if !ALLOWED.contains(&s.as_str()) {
            return Err(HttpError::validation(format!("unknown scope: {s}")));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct RevokeRequest {
    pub token_id: Uuid,
}

#[derive(Debug, Serialize)]
pub struct RevokeResponse {
    pub revoked: bool,
}

pub async fn revoke_handler(
    _root: RootAuth,
    State(state): State<HttpState>,
    Json(req): Json<RevokeRequest>,
) -> Result<Json<RevokeResponse>, HttpError> {
    let revoked = state.tokens.revoke(req.token_id);
    Ok(Json(RevokeResponse { revoked }))
}

#[derive(Debug, Serialize)]
pub struct TokenListResponse {
    pub tokens: Vec<SessionTokenSummary>,
}

pub async fn list_tokens_handler(
    _root: RootAuth,
    State(state): State<HttpState>,
) -> Result<Json<TokenListResponse>, HttpError> {
    let tokens = state
        .tokens
        .list()
        .iter()
        .map(SessionTokenSummary::from)
        .collect();
    Ok(Json(TokenListResponse { tokens }))
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct SseQuery {
    #[serde(default)]
    pub access_token: Option<String>,
}

// Re-export so route table need not name the type via full path.
pub type _SseQueryAlias = Query<SseQuery>;

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    fn parts_with_authz(value: &str) -> Parts {
        let mut req = Request::builder().uri("/").body(()).unwrap();
        req.headers_mut().insert(
            header::AUTHORIZATION,
            header::HeaderValue::from_str(value).unwrap(),
        );
        req.into_parts().0
    }

    fn parts_with_query(query: &str) -> Parts {
        let req = Request::builder()
            .uri(format!("/x?{query}"))
            .body(())
            .unwrap();
        req.into_parts().0
    }

    #[test]
    fn bearer_header_parsed() {
        let parts = parts_with_authz("Bearer abc.def");
        assert_eq!(extract_bearer(&parts).unwrap(), "abc.def");
    }

    #[test]
    fn wrong_scheme_rejected() {
        let parts = parts_with_authz("Basic xxx");
        assert!(extract_bearer(&parts).is_err());
    }

    #[test]
    fn query_fallback() {
        let parts = parts_with_query("access_token=zzz");
        assert_eq!(extract_bearer(&parts).unwrap(), "zzz");
    }

    #[test]
    fn missing_token_unauthorized() {
        let parts = parts_with_query("foo=bar");
        let err = extract_bearer(&parts).unwrap_err();
        assert_eq!(err.code, super::super::errors::ErrorCode::Unauthorized);
    }

    #[test]
    fn scope_check() {
        let p = Principal {
            token_id: Uuid::new_v4(),
            scopes: vec!["sessions:read".into()],
        };
        assert!(require_scope(&p, "sessions:read").is_ok());
        assert!(require_scope(&p, "sessions:write").is_err());
    }

    #[test]
    fn percent_decode_handles_padding() {
        assert_eq!(percent_decode("a%3Db"), "a=b");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("a+b"), "a b");
    }

    #[test]
    fn validate_scopes_rejects_unknown() {
        assert!(validate_scopes(&["sessions:read".into()]).is_ok());
        assert!(validate_scopes(&["not-a-scope".into()]).is_err());
    }
}
