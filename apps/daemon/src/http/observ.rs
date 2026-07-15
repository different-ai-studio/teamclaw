//! Observability middleware: per-request id and structured tracing.
//!
//! Every response carries an `X-Request-Id` header (ULID-shaped, 26 chars
//! crockford base32). Logs emitted inside a handler include the same id so
//! a single grep links request and response. The id is also exposed to
//! handlers via the `RequestId` extension so error responses can echo it.

use axum::{
    body::Body,
    http::{header, HeaderName, HeaderValue, Request},
    middleware::Next,
    response::Response,
};
use std::time::Instant;

/// Header name used both for the inbound override (clients may supply
/// their own correlation id) and the outbound echo.
pub const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

#[derive(Clone, Debug)]
pub struct RequestId(#[allow(dead_code)] pub String);

/// Generate a Crockford-base32 ULID-shaped id without pulling the `ulid`
/// crate. 26 chars = 130 bits of randomness; good enough for log
/// correlation, never used as a security token.
fn new_request_id() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut rng = rand::thread_rng();
    (0..26)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

/// Middleware: install or echo a request id, and log a single structured
/// line per request at completion. Stays cheap — no per-handler spans, no
/// allocation beyond the id itself.
pub async fn request_id_layer(mut req: Request<Body>, next: Next) -> Response {
    let id = req
        .headers()
        .get(&REQUEST_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_graphic()))
        .map(|s| s.to_owned())
        .unwrap_or_else(new_request_id);

    req.extensions_mut().insert(RequestId(id.clone()));

    let method = req.method().clone();
    let uri = req.uri().clone();
    let started = Instant::now();
    let mut resp = next.run(req).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    if let Ok(value) = HeaderValue::from_str(&id) {
        resp.headers_mut().insert(REQUEST_ID_HEADER, value);
    }

    let status = resp.status().as_u16();
    if status >= 500 {
        tracing::error!(request_id = %id, %method, %uri, status, elapsed_ms, "http request");
    } else if status >= 400 {
        tracing::warn!(request_id = %id, %method, %uri, status, elapsed_ms, "http request");
    } else {
        tracing::info!(request_id = %id, %method, %uri, status, elapsed_ms, "http request");
    }

    resp
}

/// Helper accessor used by handlers that want to embed the id in a body
/// (e.g. problem+json) — the id was inserted by the middleware above.
#[allow(dead_code)]
pub fn request_id_of(req: &Request<Body>) -> Option<&str> {
    req.extensions()
        .get::<RequestId>()
        .map(|RequestId(s)| s.as_str())
}

/// Header sentinel re-exported here so other modules don't need to import
/// `axum::http::header` directly.
#[allow(dead_code)]
pub const X_REQUEST_ID: HeaderName = REQUEST_ID_HEADER;
#[allow(dead_code)]
pub const HEADER_CONTENT_TYPE: HeaderName = header::CONTENT_TYPE;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_are_unique_and_well_formed() {
        let a = new_request_id();
        let b = new_request_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 26);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
