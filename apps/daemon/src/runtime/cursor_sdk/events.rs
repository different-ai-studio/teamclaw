//! cursor-bridge stdout event routing.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{debug, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;

use super::{translate, Shared};
use crate::runtime::sidecar::client::SidecarClient;

pub(super) fn spawn_reader(
    shared: Arc<Shared>,
    worktree: String,
    stdout: tokio::process::ChildStdout,
    client: SidecarClient,
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
                    warn!(worktree, error = %e, "cursor stdout read error");
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
                    debug!(worktree, error = %e, "cursor stdout non-JSON dropped");
                    continue;
                }
            };
            if json.get("id").is_some() {
                client.resolve_response(&json);
                continue;
            }
            if json.get("event").is_some() {
                handle_event(&shared, &json).await;
            }
        }
        close_all_turns_for_worktree(&shared, &worktree).await;
        client.fail_all_pending();
        info!(worktree, "cursor bridge stdout closed");
    });
}

async fn close_all_turns_for_worktree(shared: &Arc<Shared>, worktree: &str) {
    let session_ids: Vec<String> = shared
        .routes
        .lock()
        .iter()
        .filter(|(_, r)| r.worktree == worktree && r.turn_active)
        .map(|(id, _)| id.clone())
        .collect();
    for session_id in session_ids {
        close_turn(shared, &session_id).await;
    }
}

async fn handle_event(shared: &Arc<Shared>, event: &serde_json::Value) {
    let event_name = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let agent_id = event.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
    if agent_id.is_empty() {
        return;
    }
    let session_id = format!("{}{}", super::SESSION_ID_PREFIX, agent_id);

    if event_name == "turn_end" {
        close_turn(shared, &session_id).await;
    }

    let (events, event_tx, reply_to) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(&session_id) else {
            debug!(
                session_id,
                event_name, "cursor event for unrouted session dropped"
            );
            return;
        };
        if event_name == "turn_start" {
            route.turn_active = true;
        }
        // `turn_end` carries the model the run actually used (`result.model`) —
        // the only authoritative reading we get. A `set_model` the SDK silently
        // declined would otherwise leave the route lying about its model.
        if event_name == "turn_end" {
            if let Some(model) = event
                .get("model")
                .and_then(|v| v.as_str())
                .filter(|m| !m.is_empty())
            {
                if route.model != model {
                    debug!(session_id, from = %route.model, to = model, "cursor run model changed");
                    route.model = model.to_string();
                }
            }
        }
        (
            translate::translate_event(&mut route.translate, event),
            route.event_tx.clone(),
            route.turn_reply_to.clone(),
        )
    };

    for ev in events {
        crate::runtime::agent_trace::log_acp_event(&session_id, &ev);
        let _ = event_tx
            .send(AcpEventFrame::new(session_id.clone(), ev).with_reply_to(reply_to.clone()))
            .await;
    }
}

pub(super) async fn close_turn(shared: &Arc<Shared>, session_id: &str) {
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
            .send(AcpEventFrame::new(session_id.to_string(), ev).with_reply_to(reply_to))
            .await;
    }
}
