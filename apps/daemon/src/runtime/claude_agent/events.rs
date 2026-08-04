//! claude-bridge stdout event routing.
//!
//! Unlike `cursor_sdk`, permission requests arrive **on this stream** rather
//! than out-of-band: the Agent SDK's `canUseTool` callback lives inside the
//! bridge process, so the bridge simply blocks and emits a `permission_request`
//! event. That removes the whole hooks-file / socket-callback apparatus the
//! cursor backend needs.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{debug, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::sidecar::client::SidecarClient;

use super::{permission, translate, Shared};

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
                    warn!(worktree, error = %e, "claude stdout read error");
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
                    debug!(worktree, error = %e, "claude stdout non-JSON dropped");
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
        info!(worktree, "claude bridge stdout closed");
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

/// The bridge keys events by its own session handle; map it to our acp id.
fn acp_session_for(shared: &Arc<Shared>, session_key: &str) -> Option<String> {
    shared.session_keys.lock().get(session_key).cloned()
}

async fn emit_slash_commands(shared: &Arc<Shared>, session_id: &str, event: &serde_json::Value) {
    let commands: Vec<amux::AcpAvailableCommand> = event
        .get("commands")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let name = c.get("name").and_then(|v| v.as_str())?;
                    if name.is_empty() {
                        return None;
                    }
                    Some(amux::AcpAvailableCommand {
                        name: name.to_string(),
                        description: c
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        input_hint: c
                            .get("inputHint")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if commands.is_empty() {
        return;
    }

    let event_tx = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            return;
        };
        route.event_tx.clone()
    };

    let ev = amux::AcpEvent {
        event: Some(amux::acp_event::Event::AvailableCommands(
            amux::AcpAvailableCommands { commands },
        )),
        model: String::new(),
    };
    crate::runtime::agent_trace::log_acp_event(session_id, &ev);
    let _ = event_tx
        .send(AcpEventFrame::new(session_id.to_string(), ev))
        .await;
}

async fn handle_event(shared: &Arc<Shared>, event: &serde_json::Value) {
    let event_name = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let session_key = event
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if session_key.is_empty() {
        return;
    }
    let Some(session_id) = acp_session_for(shared, session_key) else {
        debug!(
            session_key,
            event_name, "claude event before session was routed; dropped"
        );
        return;
    };

    if event_name == "permission_request" {
        permission::handle_request(shared, &session_id, session_key, event).await;
        return;
    }

    if event_name == "slash_commands" {
        emit_slash_commands(shared, &session_id, event).await;
        return;
    }

    if event_name == "turn_end" {
        close_turn(shared, &session_id).await;
    }

    let (events, event_tx, reply_to) = {
        let mut routes = shared.routes.lock();
        let Some(route) = routes.get_mut(&session_id) else {
            debug!(
                session_id,
                event_name, "claude event for unrouted session dropped"
            );
            return;
        };
        if event_name == "turn_start" {
            route.turn_active = true;
        }
        // `turn_end` carries the model that actually ran the turn (the SDK's
        // `result.modelUsage` key), which is the only authoritative reading.
        if event_name == "turn_end" {
            if let Some(model) = event
                .get("model")
                .and_then(|v| v.as_str())
                .filter(|m| !m.is_empty())
            {
                let flat = super::flat_model_id(model);
                if route.model != flat {
                    debug!(session_id, from = %route.model, to = %flat, "claude run model changed");
                    route.model = flat;
                }
            }
        }
        (
            translate::translate_event(event),
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
