//! cursor-bridge stdout event routing.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{debug, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;

use super::client::CursorClient;
use super::{translate, Shared};

pub(super) fn spawn_reader(
    shared: Arc<Shared>,
    worktree: String,
    stdout: tokio::process::ChildStdout,
    client: CursorClient,
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

    if event_name == "permission_request" {
        handle_permission(shared, &session_id, event).await;
        return;
    }

    if event_name == "turn_end" {
        close_turn(shared, &session_id).await;
    }

    let (events, event_tx, reply_to) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(&session_id) else {
            debug!(session_id, event_name, "cursor event for unrouted session dropped");
            return;
        };
        if event_name == "turn_start" {
            route.turn_active = true;
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

async fn handle_permission(shared: &Arc<Shared>, session_id: &str, event: &serde_json::Value) {
    let request_id = event
        .get("requestId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if request_id.is_empty() {
        return;
    }
    let (permission, event_tx, requester, reply_to, worktree, agent_id) = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            return;
        };
        (
            route.permission,
            route.event_tx.clone(),
            route.turn_requester.clone(),
            route.turn_reply_to.clone(),
            route.worktree.clone(),
            route.agent_id.clone(),
        )
    };

    if permission.is_full_access() {
        if let Some(proc) = shared.pool.get(&worktree) {
            let _ = proc
                .client
                .request(
                    "resolve_permission",
                    serde_json::json!({ "agentId": agent_id, "requestId": request_id, "granted": true }),
                )
                .await;
        }
        return;
    }

    let mut params = std::collections::HashMap::new();
    params.insert("request_id".to_string(), request_id.clone());
    if let Some(actor) = requester {
        params.insert("requester_actor_id".to_string(), actor);
    }
    let ev = amux::AcpEvent {
        event: Some(amux::acp_event::Event::PermissionRequest(
            amux::AcpPermissionRequest {
                request_id: request_id.clone(),
                tool_name: "cursor".to_string(),
                description: "Cursor agent permission request".to_string(),
                params,
                options: vec![],
            },
        )),
        model: String::new(),
    };
    shared.permissions.lock().insert(
        request_id.clone(),
        super::PendingPermission {
            session_id: session_id.to_string(),
            agent_id,
            request_id,
        },
    );
    crate::runtime::agent_trace::log_acp_event(session_id, &ev);
    let _ = event_tx
        .send(AcpEventFrame::new(session_id.to_string(), ev).with_reply_to(reply_to))
        .await;
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
