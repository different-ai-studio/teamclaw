//! Per-process stdout reader + event routing.
//!
//! One reader task per pi child. Records are split on `\n` only (pi writes
//! one JSON object per line; U+2028 etc. are valid inside strings and must
//! not split records — `read_line` matches that contract). `response` lines
//! are routed back to the awaiting [`super::client::PiClient`] request;
//! everything else is an event for the process's currently active session.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{debug, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;

use super::client::PiClient;
use super::{translate, Shared};

pub(super) fn spawn_reader(
    shared: Arc<Shared>,
    worktree: String,
    stdout: tokio::process::ChildStdout,
    client: PiClient,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) => {
                    warn!(worktree, error = %e, "pi stdout read error");
                    break;
                }
            }
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue;
            }
            let json: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    debug!(worktree, error = %e, "pi stdout non-JSON line dropped");
                    continue;
                }
            };
            if json.get("type").and_then(|v| v.as_str()) == Some("response") {
                client.resolve_response(&json);
                continue;
            }
            handle_event(&shared, &worktree, &client, &json).await;
        }
        client.fail_all_pending();
        info!(worktree, "pi rpc stdout closed");
    });
}

/// The acp session currently bound to this worktree's process.
fn active_session(shared: &Arc<Shared>, worktree: &str) -> Option<String> {
    shared
        .pool
        .get(worktree)
        .and_then(|p| p.active_acp_session.lock().clone())
}

async fn handle_event(
    shared: &Arc<Shared>,
    worktree: &str,
    client: &PiClient,
    event: &serde_json::Value,
) {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if event_type == "extension_ui_request" {
        handle_ui_request(shared, worktree, client, event).await;
        return;
    }
    let Some(session_id) = active_session(shared, worktree) else {
        debug!(
            worktree,
            event_type, "pi event with no active session dropped"
        );
        return;
    };

    match event_type {
        "agent_start" => {
            if let Some(route) = shared.routes.lock().get_mut(&session_id) {
                route.translate.reset_turn();
            }
        }
        // Turn completion contract: same Active→Idle StatusChange the
        // opencode backend emits on `session.idle`. `turn_active` guards
        // against double-close when both turn_end and agent_settled arrive.
        "turn_end" | "agent_settled" => close_turn(shared, &session_id).await,
        _ => {
            let (events, event_tx, reply_to) = {
                let mut routes = shared.routes.lock();
                let Some(route) = routes.get_mut(&session_id) else {
                    debug!(
                        session_id,
                        event_type, "pi event for unrouted session dropped"
                    );
                    return;
                };
                (
                    translate::translate_event(&mut route.translate, event),
                    route.event_tx.clone(),
                    route.turn_reply_to.clone(),
                )
            };
            for ev in events {
                crate::runtime::agent_trace::log_acp_event(&session_id, &ev);
                let _ = event_tx
                    .send(
                        AcpEventFrame::new(session_id.clone(), ev).with_reply_to(reply_to.clone()),
                    )
                    .await;
            }
        }
    }
}

async fn close_turn(shared: &Arc<Shared>, session_id: &str) {
    let closed = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(session_id) else {
            return;
        };
        if !route.turn_active {
            None
        } else {
            route.turn_active = false;
            let reply_to = route.turn_reply_to.take();
            route.turn_requester = None;
            Some((route.event_tx.clone(), reply_to))
        }
    };
    if let Some((event_tx, reply_to)) = closed {
        let ev = crate::runtime::opencode_http::translate::status_change(
            amux::AgentStatus::Active,
            amux::AgentStatus::Idle,
        );
        crate::runtime::agent_trace::log_acp_event(session_id, &ev);
        let _ = event_tx
            .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
            .await;
    }
}

/// Dialog methods block pi until an `extension_ui_response` arrives; a
/// missing reply hangs the extension. Confirm dialogs are the permission
/// channel; other dialog methods get cancelled (unsupported over amux).
async fn handle_ui_request(
    shared: &Arc<Shared>,
    worktree: &str,
    client: &PiClient,
    event: &serde_json::Value,
) {
    let id = event
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let method = event.get("method").and_then(|v| v.as_str()).unwrap_or("");
    match method {
        "confirm" => {
            let Some(session_id) = active_session(shared, worktree) else {
                warn!(worktree, "pi confirm with no active session; rejecting");
                let _ = client
                    .notify(serde_json::json!({
                        "type": "extension_ui_response", "id": id, "confirmed": false
                    }))
                    .await;
                return;
            };
            let (is_gateway, event_tx, requester, reply_to) = {
                let routes = shared.routes.lock();
                let Some(route) = routes.get(&session_id) else {
                    return;
                };
                (
                    route.is_gateway,
                    route.event_tx.clone(),
                    route.turn_requester.clone(),
                    route.turn_reply_to.clone(),
                )
            };
            if is_gateway {
                // Gateway sessions auto-allow tool permissions.
                info!(session_id, ui_id = %id, "auto-allow gateway pi confirm");
                if let Err(e) = client
                    .notify(serde_json::json!({
                        "type": "extension_ui_response", "id": id, "confirmed": true
                    }))
                    .await
                {
                    warn!(session_id, error = %e, "gateway pi confirm auto-reply failed");
                }
                return;
            }
            let always_pattern = event
                .get("message")
                .and_then(|v| v.as_str())
                .and_then(translate::extract_always_pattern);
            shared.permissions.lock().insert(
                id,
                super::PendingPermission {
                    session_id: session_id.clone(),
                    always_pattern,
                },
            );
            let ev = translate::permission_request_event(event, requester.as_deref());
            crate::runtime::agent_trace::log_acp_event(&session_id, &ev);
            let _ = event_tx
                .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
                .await;
        }
        // Other dialog methods block until answered — cancel them.
        "select" | "input" | "editor" => {
            warn!(worktree, method, "unsupported pi dialog method; cancelling");
            let _ = client
                .notify(serde_json::json!({
                    "type": "extension_ui_response", "id": id, "cancelled": true
                }))
                .await;
        }
        // Fire-and-forget methods (notify/setStatus/setWidget/…): no reply.
        _ => {}
    }
}
