//! The `preToolUse` hook's daemon side: surface the request to a human, wait,
//! answer `allow` / `deny`.
//!
//! Flow: SDK → `amuxd cursor-permission-hook` (spawned per tool call) →
//! `amuxd.sock` → here → `AcpPermissionRequest` to clients → human →
//! `AcpCommand::ResolvePermission` → [`resolve`] → back down the same wire.
//!
//! Deliberately fail-open: an unroutable request, an unknown worktree or a
//! resolution timeout answers `allow`. A `preToolUse` gate that fails closed
//! bricks every tool call in the session the moment anything upstream hiccups,
//! which is a far worse failure than the pre-existing "no gate at all".

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::proto::amux;
use crate::runtime::acp_event_frame::AcpEventFrame;
use crate::runtime::opencode_http::translate::permission_options;

use super::{canonical_dir, Shared};

/// Ceiling on how long a client may leave a request unanswered. Slightly under
/// the hook's own `timeout` so we answer before the SDK gives up on us.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(super::hooks::HOOK_TIMEOUT_SECS - 15);

pub(crate) struct PendingPermission {
    #[allow(dead_code)]
    pub(crate) session_id: String,
    /// Canonical worktree, for a persisted "always" grant.
    pub(crate) worktree: String,
    pub(crate) tool_name: String,
    /// Fired by [`resolve`] with the human's answer.
    pub(crate) responder: oneshot::Sender<bool>,
}

fn allow() -> Value {
    json!({ "permission": "allow" })
}

fn deny(tool_name: &str) -> Value {
    json!({
        "permission": "deny",
        "user_message": format!("{tool_name} was rejected by the TeamClaw user"),
        "agent_message": format!(
            "The user rejected this {tool_name} call. Do not retry it; \
             pick another approach or ask what to do instead."
        ),
    })
}

/// Human-readable one-liner for the approval UI.
fn describe(tool_name: &str, tool_input: &Value) -> String {
    for key in ["command", "file_path", "path", "url", "query"] {
        if let Some(v) = tool_input.get(key).and_then(|v| v.as_str()) {
            if !v.is_empty() {
                return format!("{tool_name}: {v}");
            }
        }
    }
    tool_name.to_string()
}

fn params_from_input(tool_input: &Value) -> HashMap<String, String> {
    match tool_input {
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| {
                let s = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                (k.clone(), s)
            })
            .collect(),
        _ => HashMap::new(),
    }
}

/// Route a hook request to the session running in `worktree`. A worktree can
/// host more than one runtime session, but only the one mid-turn can be making
/// a tool call, so an active turn is the discriminator.
fn route_for_worktree(shared: &Arc<Shared>, worktree: &str) -> Option<RouteSnapshot> {
    let routes = shared.routes.lock();
    let mut candidates: Vec<&String> = routes
        .iter()
        .filter(|(_, r)| r.worktree == worktree)
        .map(|(id, _)| id)
        .collect();
    candidates.sort();
    let chosen = candidates
        .iter()
        .find(|id| routes.get(**id).is_some_and(|r| r.turn_active))
        .or_else(|| candidates.first())?;
    let route = routes.get(*chosen)?;
    Some(RouteSnapshot {
        session_id: (*chosen).clone(),
        event_tx: route.event_tx.clone(),
        full_access: route.permission.is_full_access(),
        requester: route.turn_requester.clone(),
        reply_to: route.turn_reply_to.clone(),
    })
}

struct RouteSnapshot {
    session_id: String,
    event_tx: tokio::sync::mpsc::Sender<AcpEventFrame>,
    full_access: bool,
    requester: Option<String>,
    reply_to: Option<String>,
}

/// Handle one `{cmd:"cursor-permission", worktree, request}` sock envelope.
/// Always resolves to a hook response body.
pub async fn handle(payload: &Value) -> Value {
    let shared = super::shared();
    let request = payload.get("request").unwrap_or(&Value::Null);
    let tool_name = request
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let tool_input = request
        .get("tool_input")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let worktree = payload
        .get("worktree")
        .and_then(|v| v.as_str())
        .map(canonical_dir)
        .unwrap_or_default();

    let Some(route) = route_for_worktree(&shared, &worktree) else {
        warn!(
            worktree,
            tool_name, "cursor permission: no session for worktree; allowing"
        );
        return allow();
    };

    if route.full_access {
        return allow();
    }
    if always_allowed(&worktree, &tool_name) {
        return allow();
    }

    let request_id = format!("cursor-perm-{}", uuid_v4());
    let (tx, rx) = oneshot::channel();
    shared.permissions.lock().insert(
        request_id.clone(),
        PendingPermission {
            session_id: route.session_id.clone(),
            worktree: worktree.clone(),
            tool_name: tool_name.clone(),
            responder: tx,
        },
    );

    let mut params = params_from_input(&tool_input);
    if let Some(actor) = route.requester.clone() {
        params.insert("requester_actor_id".to_string(), actor);
    }
    params.insert("request_id".to_string(), request_id.clone());
    let ev = amux::AcpEvent {
        event: Some(amux::acp_event::Event::PermissionRequest(
            amux::AcpPermissionRequest {
                request_id: request_id.clone(),
                tool_name: tool_name.clone(),
                description: describe(&tool_name, &tool_input),
                params,
                options: permission_options(),
            },
        )),
        model: String::new(),
    };
    crate::runtime::agent_trace::log_acp_event(&route.session_id, &ev);
    if route
        .event_tx
        .send(AcpEventFrame::new(route.session_id.clone(), ev).with_reply_to(route.reply_to))
        .await
        .is_err()
    {
        shared.permissions.lock().remove(&request_id);
        warn!(
            session_id = %route.session_id,
            "cursor permission: event channel closed; allowing"
        );
        return allow();
    }

    match tokio::time::timeout(RESOLVE_TIMEOUT, rx).await {
        Ok(Ok(true)) => allow(),
        Ok(Ok(false)) => deny(&tool_name),
        Ok(Err(_)) => {
            warn!(request_id, "cursor permission: resolver dropped; allowing");
            allow()
        }
        Err(_) => {
            shared.permissions.lock().remove(&request_id);
            warn!(
                request_id,
                tool_name, "cursor permission: timed out; allowing"
            );
            allow()
        }
    }
}

/// Answer a pending request. `option_id == "always"` also persists a
/// worktree-scoped grant for that tool name, since the SDK has no notion of a
/// standing approval we could hand back to it.
pub(crate) fn resolve(
    shared: &Arc<Shared>,
    request_id: &str,
    granted: bool,
    option_id: Option<&str>,
) {
    let Some(pending) = shared.permissions.lock().remove(request_id) else {
        warn!(request_id, "no pending cursor permission");
        return;
    };
    if granted && option_id == Some("always") {
        let PendingPermission {
            worktree,
            tool_name,
            ..
        } = &pending;
        if let Err(e) = persist_always(worktree, tool_name) {
            warn!(worktree, tool_name, error = %e, "cursor always-allow write failed");
        } else {
            info!(worktree, tool_name, "cursor always-allow persisted");
        }
    }
    let _ = pending.responder.send(granted);
}

// ---------------------------------------------------------------------------
// "Always allow" store — worktree → tool names
// ---------------------------------------------------------------------------

fn always_store_path() -> PathBuf {
    crate::config::DaemonConfig::config_dir().join("cursor-permissions.json")
}

fn read_always_store() -> Value {
    std::fs::read_to_string(always_store_path())
        .ok()
        .and_then(|b| serde_json::from_str::<Value>(&b).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}))
}

fn always_allowed(worktree: &str, tool_name: &str) -> bool {
    read_always_store()
        .get(worktree)
        .and_then(|v| v.as_array())
        .is_some_and(|tools| tools.iter().any(|t| t.as_str() == Some(tool_name)))
}

fn persist_always(worktree: &str, tool_name: &str) -> std::io::Result<()> {
    if worktree.is_empty() {
        return Ok(());
    }
    let mut store = read_always_store();
    let entry = store
        .as_object_mut()
        .expect("read_always_store returns an object")
        .entry(worktree.to_string())
        .or_insert_with(|| json!([]));
    let tools = match entry.as_array_mut() {
        Some(tools) => tools,
        None => {
            *entry = json!([]);
            entry.as_array_mut().expect("just set to an array")
        }
    };
    if !tools.iter().any(|t| t.as_str() == Some(tool_name)) {
        tools.push(json!(tool_name));
    }
    let path = always_store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&store)?)
}

/// Random-enough request id without pulling in a uuid dependency for one call.
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{nanos:x}-{:x}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_prefers_the_most_specific_input_field() {
        assert_eq!(
            describe("shell", &json!({ "command": "rm -rf /", "cwd": "/w" })),
            "shell: rm -rf /"
        );
        assert_eq!(
            describe("write", &json!({ "file_path": "/w/a.rs" })),
            "write: /w/a.rs"
        );
        assert_eq!(describe("weird", &json!({ "n": 3 })), "weird");
        assert_eq!(describe("empty", &json!({ "command": "" })), "empty");
    }

    #[test]
    fn params_stringify_non_string_values() {
        let params = params_from_input(&json!({ "a": "x", "n": 3, "b": true }));
        assert_eq!(params.get("a"), Some(&"x".to_string()));
        assert_eq!(params.get("n"), Some(&"3".to_string()));
        assert_eq!(params.get("b"), Some(&"true".to_string()));
        assert!(params_from_input(&json!("scalar")).is_empty());
    }

    #[test]
    fn deny_body_carries_both_messages() {
        let body = deny("shell");
        assert_eq!(body["permission"], json!("deny"));
        assert!(body["user_message"].as_str().unwrap().contains("shell"));
        assert!(body["agent_message"].as_str().unwrap().contains("retry"));
    }

    /// Register a route on the process-global backend state. Each test uses a
    /// distinct worktree so the shared tables do not collide under `cargo test`.
    fn register_route(
        worktree: &str,
        permission: crate::runtime::permission_policy::PermissionPolicy,
    ) -> (String, tokio::sync::mpsc::Receiver<AcpEventFrame>) {
        let (event_tx, event_rx) = tokio::sync::mpsc::channel(8);
        let session_id = format!("cursor:agent-for-{worktree}");
        super::super::shared().routes.lock().insert(
            session_id.clone(),
            super::super::Route {
                event_tx,
                permission,
                worktree: worktree.to_string(),
                agent_id: "agent".into(),
                turn_active: true,
                turn_reply_to: Some("msg-1".into()),
                turn_requester: Some("actor-1".into()),
                translate: Default::default(),
                model: "cursor/composer-2.5".into(),
            },
        );
        (session_id, event_rx)
    }

    fn request(tool: &str) -> Value {
        json!({
            "worktree": "/tmp/does-not-need-to-exist",
            "request": { "tool_name": tool, "tool_input": { "command": "rm -rf /" } }
        })
    }

    #[tokio::test]
    async fn full_access_allows_without_asking_anyone() {
        let worktree = "/tmp/cursor-perm-full";
        let (_id, mut rx) = register_route(
            worktree,
            crate::runtime::permission_policy::PermissionPolicy::Full,
        );
        let mut payload = request("shell");
        payload["worktree"] = json!(worktree);

        let body = handle(&payload).await;
        assert_eq!(body["permission"], json!("allow"));
        assert!(
            rx.try_recv().is_err(),
            "full access must not surface a request"
        );
    }

    #[tokio::test]
    async fn ask_policy_surfaces_a_request_and_honours_a_denial() {
        let worktree = "/tmp/cursor-perm-deny";
        let (_id, mut rx) = register_route(
            worktree,
            crate::runtime::permission_policy::PermissionPolicy::Ask,
        );
        let mut payload = request("shell");
        payload["worktree"] = json!(worktree);

        let decision = tokio::spawn(async move { handle(&payload).await });

        let frame = rx.recv().await.expect("a permission request is emitted");
        let amux::acp_event::Event::PermissionRequest(req) =
            frame.event.event.clone().expect("event present")
        else {
            panic!("expected a PermissionRequest, got {:?}", frame.event.event);
        };
        assert_eq!(req.tool_name, "shell");
        assert_eq!(req.description, "shell: rm -rf /");
        assert_eq!(
            req.params.get("requester_actor_id").map(String::as_str),
            Some("actor-1")
        );
        assert_eq!(req.options.len(), 3, "once / always / reject");

        resolve(
            &super::super::shared(),
            &req.request_id,
            false,
            Some("reject"),
        );

        let body = decision.await.unwrap();
        assert_eq!(body["permission"], json!("deny"));
        assert!(body["agent_message"].is_string());
    }

    #[tokio::test]
    async fn ask_policy_honours_an_approval() {
        let worktree = "/tmp/cursor-perm-allow";
        let (_id, mut rx) = register_route(
            worktree,
            crate::runtime::permission_policy::PermissionPolicy::Ask,
        );
        let mut payload = request("write");
        payload["worktree"] = json!(worktree);

        let decision = tokio::spawn(async move { handle(&payload).await });
        let frame = rx.recv().await.expect("a permission request is emitted");
        let amux::acp_event::Event::PermissionRequest(req) =
            frame.event.event.clone().expect("event present")
        else {
            panic!("expected a PermissionRequest");
        };
        resolve(&super::super::shared(), &req.request_id, true, Some("once"));

        assert_eq!(decision.await.unwrap()["permission"], json!("allow"));
    }

    #[test]
    fn resolving_an_unknown_request_is_a_no_op() {
        resolve(&super::super::shared(), "no-such-request", true, None);
    }

    #[tokio::test]
    async fn unroutable_request_fails_open() {
        let body = handle(&json!({
            "worktree": "/nonexistent/worktree",
            "request": { "tool_name": "shell", "tool_input": { "command": "ls" } }
        }))
        .await;
        assert_eq!(body["permission"], json!("allow"));
    }
}
