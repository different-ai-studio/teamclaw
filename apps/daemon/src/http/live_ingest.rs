//! `POST /v1/session-live/ingest` — local fast-path twin of MQTT session/live.
//!
//! Same-machine clients publish the exact `teamclu.LiveEventEnvelope`
//! protobuf bytes they would otherwise send to
//! `amux/{team}/session/{id}/live`. The daemon actor loop runs the same
//! `route_session_message` sink (including `message_id` dedup), so a later
//! MQTT copy of the same envelope is a no-op.

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use tokio::sync::oneshot;

use super::auth::{require_scope, Principal};
use super::errors::{ErrorCode, HttpError};
use super::state::{HttpState, LocalLiveIngestRequest};

const INGEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

#[derive(Debug, Deserialize)]
pub struct IngestQuery {
    pub session_id: String,
}

/// `POST /v1/session-live/ingest?session_id=…`
///
/// Body: raw `application/x-protobuf` `LiveEventEnvelope` bytes.
pub async fn ingest(
    principal: Principal,
    State(state): State<HttpState>,
    Query(query): Query<IngestQuery>,
    body: Bytes,
) -> Result<StatusCode, HttpError> {
    require_scope(&principal, "sessions:write")?;
    let session_id = query.session_id.trim().to_owned();
    if session_id.is_empty() {
        return Err(HttpError::validation("session_id is required"));
    }
    let Some(tx) = &state.local_live_ingest_tx else {
        return Err(HttpError::new(
            ErrorCode::RuntimeUnavailable,
            "local live-ingest bridge not attached (daemon actor loop not running)",
        ));
    };
    if body.is_empty() {
        return Err(HttpError::validation("empty live envelope payload"));
    }

    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send(LocalLiveIngestRequest {
        session_id,
        payload: body.to_vec(),
        reply_tx,
    })
    .await
    .map_err(|_| {
        HttpError::new(
            ErrorCode::RuntimeUnavailable,
            "daemon actor loop unavailable (live-ingest bridge closed)",
        )
    })?;

    let reply = tokio::time::timeout(INGEST_TIMEOUT, reply_rx)
        .await
        .map_err(|_| HttpError::new(ErrorCode::RuntimeUnavailable, "live ingest timed out"))?
        .map_err(|_| {
            HttpError::new(
                ErrorCode::RuntimeUnavailable,
                "daemon actor loop dropped the live-ingest reply",
            )
        })?;

    match reply {
        Ok(()) => Ok(StatusCode::ACCEPTED),
        Err(e) => Err(HttpError::validation(format!("live ingest failed: {e}"))),
    }
}
