//! SSE subscription + per-session event routing.
//!
//! One SSE task per distinct canonical worktree directory (`GET /event` is
//! directory-scoped). Each task reconnects with backoff — which also covers
//! serve restarts, since it re-`ensure()`s the supervisor on every attempt —
//! parses `data: {json}` lines, and routes events by `sessionID` to the
//! registered per-session route.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use tracing::{debug, info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;

use super::{translate, Shared};

const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// Ensure a running SSE task for `directory` (canonicalized by the caller).
pub(super) fn ensure_sse_task(shared: &Arc<Shared>, directory: &str) {
    let mut tasks = shared.sse_tasks.lock();
    if let Some(handle) = tasks.get(directory) {
        if !handle.is_finished() {
            return;
        }
    }
    let dir = directory.to_string();
    let shared_clone = Arc::clone(shared);
    tasks.insert(
        directory.to_string(),
        tokio::spawn(sse_loop(shared_clone, dir)),
    );
}

async fn sse_loop(shared: Arc<Shared>, directory: String) {
    let mut backoff = BACKOFF_MIN;
    loop {
        let client = match shared.serve.ensure().await {
            Ok(c) => c,
            Err(e) => {
                warn!(directory = %directory, error = %e, "SSE: serve unavailable; retrying");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
                continue;
            }
        };
        match client.event_stream(&directory).await {
            Ok(resp) => {
                info!(directory = %directory, "opencode SSE subscribed");
                backoff = BACKOFF_MIN;
                let mut stream = resp.bytes_stream();
                let mut buf = Vec::new();
                while let Some(chunk) = stream.next().await {
                    let chunk = match chunk {
                        Ok(c) => c,
                        Err(e) => {
                            warn!(directory = %directory, error = %e, "SSE read error");
                            break;
                        }
                    };
                    buf.extend_from_slice(&chunk);
                    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=pos).collect();
                        let line = String::from_utf8_lossy(&line);
                        let line = line.trim_end();
                        if let Some(payload) = line
                            .strip_prefix("data: ")
                            .or_else(|| line.strip_prefix("data:"))
                        {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) {
                                handle_event(&shared, &json).await;
                            }
                        }
                    }
                }
                warn!(directory = %directory, "opencode SSE stream ended; reconnecting");
            }
            Err(e) => {
                warn!(directory = %directory, error = %e, "SSE subscribe failed");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
        // Nothing left to route for? Keep the subscription anyway — sessions
        // for this directory may be re-attached after a daemon-side resume.
        tokio::time::sleep(BACKOFF_MIN).await;
    }
}

fn event_session_id(event_type: &str, props: &serde_json::Value) -> Option<String> {
    props
        .get("sessionID")
        .and_then(|v| v.as_str())
        .or_else(|| props.pointer("/part/sessionID").and_then(|v| v.as_str()))
        .or_else(|| props.pointer("/info/sessionID").and_then(|v| v.as_str()))
        .or_else(|| {
            // session.updated / session.created carry the Session object.
            if event_type.starts_with("session.") {
                props.pointer("/info/id").and_then(|v| v.as_str())
            } else {
                None
            }
        })
        .map(str::to_string)
}

async fn handle_event(shared: &Arc<Shared>, event: &serde_json::Value) {
    let Some(event_type) = event.get("type").and_then(|v| v.as_str()) else {
        return;
    };
    if event_type.starts_with("server.")
        || event_type.starts_with("storage.")
        || event_type.starts_with("file.")
        || event_type.starts_with("lsp.")
    {
        return;
    }
    let props = event
        .get("properties")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let Some(session_id) = event_session_id(event_type, &props) else {
        return;
    };

    match event_type {
        "permission.asked" => handle_permission_asked(shared, &session_id, &props).await,
        "session.idle" => handle_session_idle(shared, &session_id).await,
        "session.updated" => handle_session_updated(shared, &session_id, &props).await,
        "session.status" => handle_session_status(shared, &session_id, &props).await,
        "question.asked" => handle_question_asked(shared, &session_id, &props).await,
        "question.replied" | "question.rejected" => {
            handle_question_resolved(shared, &session_id, event_type, &props).await
        }
        _ => {
            // Pure translation path (text/reasoning/tool deltas, errors).
            let (events, event_tx, reply_to) = {
                let mut routes = shared.routes.lock();
                let Some(route) = routes.get_mut(&session_id) else {
                    debug!(
                        session_id,
                        event_type, "SSE event for unrouted session dropped"
                    );
                    return;
                };
                let events = translate::translate_event(&mut route.translate, event_type, &props);
                if !events.is_empty() {
                    // First token/tool/error arrived — the stuck-turn
                    // watchdog (mod.rs) stands down for this turn.
                    route.turn_saw_output = true;
                }
                (events, route.event_tx.clone(), route.turn_reply_to.clone())
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

async fn handle_permission_asked(
    shared: &Arc<Shared>,
    session_id: &str,
    props: &serde_json::Value,
) {
    let permission_id = props
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let (is_gateway, directory, event_tx, requester) = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            warn!(session_id, "permission.asked for unrouted session");
            return;
        };
        (
            route.is_gateway,
            route.directory.clone(),
            route.event_tx.clone(),
            route.turn_requester.clone(),
        )
    };

    if is_gateway {
        // Gateway sessions auto-allow tool permissions (old adapter behavior).
        info!(session_id, permission_id = %permission_id, "auto-allow gateway permission");
        if let Ok(client) = shared.serve.ensure().await {
            if let Err(e) = client
                .permission_respond(&directory, session_id, &permission_id, "once")
                .await
            {
                warn!(session_id, error = %e, "gateway permission auto-reply failed");
            }
        }
        return;
    }

    shared
        .permissions
        .lock()
        .insert(permission_id.clone(), session_id.to_string());
    let ev = translate::permission_request_event(props, requester.as_deref());
    crate::runtime::agent_trace::log_acp_event(session_id, &ev);
    let reply_to = shared
        .routes
        .lock()
        .get(session_id)
        .and_then(|r| r.turn_reply_to.clone());
    let _ = event_tx
        .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
        .await;
}

/// opencode's `question` tool asks the user to pick/type answers. Register
/// the request (id → session, for the reply endpoint) and forward the full
/// request JSON to clients as a `question_asked` raw control event; the
/// desktop renders it as an interactive QuestionCard on the tool call.
async fn handle_question_asked(
    shared: &Arc<Shared>,
    session_id: &str,
    props: &serde_json::Value,
) {
    let Some(request_id) = props.get("id").and_then(|v| v.as_str()) else {
        return;
    };
    shared
        .questions
        .lock()
        .insert(request_id.to_string(), session_id.to_string());
    forward_question_raw(shared, session_id, "question_asked", props).await;
}

/// question.replied / question.rejected — drop the pending registration and
/// tell clients to clear the interactive card.
async fn handle_question_resolved(
    shared: &Arc<Shared>,
    session_id: &str,
    event_type: &str,
    props: &serde_json::Value,
) {
    if let Some(request_id) = props.get("requestID").and_then(|v| v.as_str()) {
        shared.questions.lock().remove(request_id);
    }
    let method = if event_type == "question.replied" {
        "question_replied"
    } else {
        "question_rejected"
    };
    forward_question_raw(shared, session_id, method, props).await;
}

/// Re-sync pending questions for a session from `GET /question` — SSE
/// `question.asked` fires once and is lost across daemon restarts or
/// subscription gaps, leaving the client with a spinner and no card. Called
/// on session attach.
pub(super) async fn resync_pending_questions(shared: &Arc<Shared>, session_id: &str) {
    let directory = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            return;
        };
        route.directory.clone()
    };
    let client = match shared.serve.ensure().await {
        Ok(c) => c,
        Err(_) => return,
    };
    let Ok(list) = client.question_list(&directory).await else {
        return;
    };
    for request in list {
        if request.get("sessionID").and_then(|v| v.as_str()) != Some(session_id) {
            continue;
        }
        let Some(request_id) = request.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        info!(session_id, request_id, "re-syncing pending opencode question");
        shared
            .questions
            .lock()
            .insert(request_id.to_string(), session_id.to_string());
        forward_question_raw(shared, session_id, "question_asked", &request).await;
    }
}

async fn forward_question_raw(
    shared: &Arc<Shared>,
    session_id: &str,
    method: &str,
    props: &serde_json::Value,
) {
    let (event_tx, reply_to) = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            warn!(session_id, method, "question event for unrouted session");
            return;
        };
        (route.event_tx.clone(), route.turn_reply_to.clone())
    };
    let ev = amux::AcpEvent {
        event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
            method: method.into(),
            json_payload: serde_json::to_vec(props).unwrap_or_default(),
        })),
        model: String::new(),
    };
    let _ = event_tx
        .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
        .await;
}

/// `session.status` carries opencode's provider-retry state — the only place
/// a failed upstream request (out of credit, usage limit, rate limit) is
/// surfaced as an event: the assistant message keeps `error: null` while
/// opencode retries internally. When the next attempt is scheduled beyond
/// the stuck-turn window there is no point waiting — abort the turn and show
/// the provider's own message (e.g. "monthly usage limit reached…"). The
/// watchdog's `/session/status` polling covers the case where this event is
/// missed across an SSE reconnect.
async fn handle_session_status(
    shared: &Arc<Shared>,
    session_id: &str,
    props: &serde_json::Value,
) {
    let status = props.get("status").unwrap_or(&serde_json::Value::Null);
    if status.get("type").and_then(|v| v.as_str()) != Some("retry") {
        return;
    }
    let message = status
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("provider error")
        .to_string();
    let next_ms = status.get("next").and_then(|v| v.as_i64()).unwrap_or(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let wait = next_ms.saturating_sub(now_ms);
    warn!(
        session_id,
        message = %message,
        next_in_s = wait / 1000,
        "opencode provider retry status"
    );
    // Retries due within the stuck-turn window may still succeed — let them
    // run; the watchdog remains the backstop.
    if wait <= super::FIRST_OUTPUT_TIMEOUT.as_millis() as i64 {
        return;
    }
    super::abort_turn_with_error(shared, session_id, "model provider error".to_string(), message)
        .await;
}

/// opencode auto-generates a session title from the first exchange and
/// announces it via `session.updated`. Forward it as the existing
/// `session_title` raw control event; the daemon server decides whether the
/// TeamClaw session still carries a default title worth replacing.
async fn handle_session_updated(
    shared: &Arc<Shared>,
    session_id: &str,
    props: &serde_json::Value,
) {
    let title = props
        .pointer("/info/title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or_default();
    // "New session - <timestamp>" is opencode's own placeholder.
    if title.is_empty() || title.starts_with("New session") {
        return;
    }
    let (event_tx, reply_to) = {
        let routes = shared.routes.lock();
        let Some(route) = routes.get(session_id) else {
            return;
        };
        (route.event_tx.clone(), route.turn_reply_to.clone())
    };
    let ev = amux::AcpEvent {
        event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
            method: "session_title".into(),
            json_payload: title.as_bytes().to_vec(),
        })),
        model: String::new(),
    };
    let _ = event_tx
        .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
        .await;
}

async fn handle_session_idle(shared: &Arc<Shared>, session_id: &str) {
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
        let ev = translate::status_change(amux::AgentStatus::Active, amux::AgentStatus::Idle);
        crate::runtime::agent_trace::log_acp_event(session_id, &ev);
        let _ = event_tx
            .send(AcpEventFrame::new(session_id, ev).with_reply_to(reply_to))
            .await;
    }
}
