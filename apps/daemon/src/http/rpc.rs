//! `POST /v1/rpc` — local fast-path RPC dispatch.
//!
//! Same-machine twin of the MQTT `amux/{team}/{actor}/rpc/req` topic: the
//! body is the exact `teamclaw.RpcRequest` protobuf bytes a client would
//! otherwise publish there, and the response body is the encoded
//! `teamclaw.RpcResponse` bytes the daemon would otherwise publish to the
//! requester's `rpc/res` topic. Over HTTP the request/response pairing is
//! carried by the connection itself, so no correlation subscription is
//! needed (the `request_id` inside the envelope is preserved untouched).
//!
//! The handler stays protobuf-agnostic on purpose: bytes go to the daemon
//! actor loop over the `LocalRpcRequest` bridge (the actor loop owns all
//! RPC side effects — runtime spawns, cloud writes), and bytes come back.
//! This keeps the module usable from the `#[path]`-included HTTP test
//! crates that have no daemon module tree.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::sync::oneshot;

use super::auth::{require_scope, Principal};
use super::errors::{ErrorCode, HttpError};
use super::state::{HttpState, LocalRpcRequest};

/// Upper bound on how long a single dispatch may run before the HTTP caller
/// gets a timeout and (client-side) falls back to MQTT. Kept below typical
/// client-side fallback timers so the failure is crisp, not raced.
const DISPATCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// `POST /v1/rpc`
pub async fn dispatch(
    principal: Principal,
    State(state): State<HttpState>,
    body: Bytes,
) -> Result<Response, HttpError> {
    require_scope(&principal, "sessions:write")?;
    let Some(tx) = &state.local_rpc_tx else {
        return Err(HttpError::new(
            ErrorCode::RuntimeUnavailable,
            "local rpc bridge not attached (daemon actor loop not running)",
        ));
    };
    if body.is_empty() {
        return Err(HttpError::validation("empty rpc payload"));
    }

    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(LocalRpcRequest {
        payload: body.to_vec(),
        reply_tx,
    })
    .await
    .map_err(|_| {
        HttpError::new(
            ErrorCode::RuntimeUnavailable,
            "daemon actor loop unavailable (rpc bridge closed)",
        )
    })?;

    let reply = tokio::time::timeout(DISPATCH_TIMEOUT, reply_rx)
        .await
        .map_err(|_| HttpError::new(ErrorCode::RuntimeUnavailable, "rpc dispatch timed out"))?
        .map_err(|_| {
            HttpError::new(
                ErrorCode::RuntimeUnavailable,
                "daemon actor loop dropped the rpc reply",
            )
        })?;

    match reply {
        Ok(bytes) => Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/x-protobuf")
            .header(header::CACHE_CONTROL, "no-store")
            .body(axum::body::Body::from(bytes))
            .unwrap()
            .into_response()),
        Err(e) => Err(HttpError::validation(format!("rpc dispatch failed: {e}"))),
    }
}
