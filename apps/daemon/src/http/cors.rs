//! CORS layer built from `HttpConfig.allowed_origins`.
//!
//! Wildcard origins are intentionally rejected. Bearer tokens are not safe
//! to expose to arbitrary origins, so the operator must enumerate concrete
//! origins (e.g. `http://localhost:5173`, `tauri://localhost`). An empty
//! list disables CORS, which means the daemon will only answer same-origin
//! requests — appropriate for embedded-webview clients.

use axum::http::{header, HeaderName, HeaderValue, Method};
use tower_http::cors::{AllowOrigin, CorsLayer};

use super::errors::HttpError;
use super::observ::REQUEST_ID_HEADER;

/// Build a CORS layer. Returns `None` when `allowed_origins` is empty (no
/// cross-origin requests should be honoured).
pub fn build(allowed_origins: &[String]) -> Result<Option<CorsLayer>, HttpError> {
    if allowed_origins.is_empty() {
        return Ok(None);
    }
    if allowed_origins.iter().any(|o| o == "*") {
        return Err(HttpError::internal(
            "http.allowed_origins cannot contain '*' — bearer tokens require concrete origins",
        ));
    }

    let mut origins = Vec::with_capacity(allowed_origins.len());
    for o in allowed_origins {
        let v = HeaderValue::from_str(o).map_err(|e| {
            HttpError::internal(format!("invalid origin {o:?} in http.allowed_origins: {e}"))
        })?;
        origins.push(v);
    }

    let allow_headers: Vec<HeaderName> = vec![
        header::AUTHORIZATION,
        header::CONTENT_TYPE,
        header::ACCEPT,
        header::CACHE_CONTROL,
        HeaderName::from_static("last-event-id"),
        HeaderName::from_static("if-match"),
        HeaderName::from_static("idempotency-key"),
    ];
    let expose_headers: Vec<HeaderName> = vec![
        header::ETAG,
        REQUEST_ID_HEADER,
        HeaderName::from_static("x-session-id"),
    ];

    let layer = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
            Method::PATCH,
        ])
        .allow_headers(allow_headers)
        .expose_headers(expose_headers)
        .max_age(std::time::Duration::from_secs(300));
    // Intentionally no allow_credentials — bearer tokens, not cookies.
    Ok(Some(layer))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_returns_none() {
        assert!(build(&[]).unwrap().is_none());
    }
    #[test]
    fn wildcard_rejected() {
        assert!(build(&["*".into()]).is_err());
    }
    #[test]
    fn valid_origins_accepted() {
        assert!(build(&["http://localhost:5173".into()]).unwrap().is_some());
    }
    #[test]
    fn desktop_webview_origins_accepted() {
        assert!(build(&[
            "https://tauri.localhost".into(),
            "http://tauri.localhost".into(),
            "tauri://localhost".into(),
        ])
        .unwrap()
        .is_some());
    }
}
