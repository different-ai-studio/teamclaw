//! Handler for the `manage_ipc` socket command: invoke Tauri commands
//! through the webview's real IPC path, query captured IPC traffic,
//! aggregate per-command stats, emit events, and wait for events.

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Listener, Runtime};

use crate::desktop::get_emit_target;
use crate::ipc_buffer;
use crate::socket_server::SocketResponse;
use crate::tools::webview::{emit_and_wait, parse_js_response};

pub async fn handle_manage_ipc<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let action = payload
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("captured");

    match action {
        "invoke" => handle_invoke(app, &payload).await,
        "captured" => handle_captured(&payload),
        "commands" => handle_commands(),
        "clear" => {
            let cleared = ipc_buffer::global().clear();
            Ok(SocketResponse::ok(None, Some(json!({ "cleared": cleared }))))
        }
        "emit" => handle_emit(app, &payload),
        "wait_event" => handle_wait_event(app, &payload).await,
        "arm_event" => handle_arm_event(app, &payload),
        other => Ok(SocketResponse::err(
            None,
            format!(
                "Unknown manage_ipc action: {}. Valid: invoke, captured, commands, clear, emit, wait_event, arm_event",
                other
            ),
        )),
    }
}

/// Invoke a Tauri command through the webview's own IPC path. This
/// exercises the app's real invoke pipeline (including capability checks),
/// The invoke is recorded into the IPC ring buffer so `captured`/`commands`
/// can report it — this is the only reliable way the buffer fills, since
/// Tauri v2 freezes `__TAURI_INTERNALS__.invoke` and passive capture of
/// frontend-originated calls is impossible.
async fn handle_invoke<R: Runtime>(
    app: &AppHandle<R>,
    payload: &Value,
) -> Result<SocketResponse, crate::error::Error> {
    let command = match payload.get("command").and_then(|v| v.as_str()) {
        Some(c) if !c.is_empty() => c,
        _ => {
            return Ok(SocketResponse::err(
                None,
                "'command' is required for action=invoke".to_string(),
            ));
        }
    };
    let window_label = payload
        .get("window_label")
        .and_then(|v| v.as_str())
        .unwrap_or("main");
    let timeout_ms = payload
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(10_000);

    let _webview = crate::desktop::get_webview_for_eval(app, window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;
    let emit_target = get_emit_target(app, window_label);

    let args = payload.get("args").cloned().unwrap_or(json!({}));
    let args_preview = Some(args.to_string());
    let js_payload = json!({
        "command": command,
        "args": args,
        "timeoutMs": timeout_ms,
    });

    let started = std::time::Instant::now();
    let rust_timeout_secs = (timeout_ms + 2000) / 1000;
    let response = match emit_and_wait(
        app,
        &emit_target,
        "ipc-invoke",
        "ipc-invoke-response",
        js_payload,
        std::time::Duration::from_secs(rust_timeout_secs),
    )
    .await
    {
        Ok(result) => parse_js_response(&result),
        Err(e) => SocketResponse::err(None, e.to_string()),
    };

    // Record the agent-issued invoke into the IPC buffer.
    let duration_ms = Some(started.elapsed().as_millis() as u64);
    if response.success {
        let result_preview = response.data.as_ref().and_then(|d| {
            d.get("result")
                .and_then(|v| v.as_str().map(str::to_string))
                .or_else(|| Some(d.to_string()))
        });
        ipc_buffer::global().push(
            "invoke",
            command.to_string(),
            "ok",
            duration_ms,
            args_preview,
            result_preview,
            None,
        );
    } else {
        ipc_buffer::global().push(
            "invoke",
            command.to_string(),
            "error",
            duration_ms,
            args_preview,
            None,
            response.error.clone(),
        );
    }

    Ok(response)
}

fn handle_captured(payload: &Value) -> Result<SocketResponse, crate::error::Error> {
    let kind = payload.get("kind").and_then(|v| v.as_str());
    let name_contains = payload.get("name_contains").and_then(|v| v.as_str());
    let status = payload.get("status").and_then(|v| v.as_str());
    let since_id = payload.get("since_id").and_then(|v| v.as_u64());
    let limit = payload
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(50)
        .min(500) as usize;

    let (entries, total_matched, dropped) =
        ipc_buffer::global().query(kind, name_contains, status, since_id, limit);

    Ok(SocketResponse::ok(
        None,
        Some(json!({
            "entries": entries,
            "returned": entries.len(),
            "total_matched": total_matched,
            "dropped_total": dropped,
        })),
    ))
}

fn handle_commands() -> Result<SocketResponse, crate::error::Error> {
    let observed = ipc_buffer::global().command_stats();
    let exposed = ipc_buffer::exposed_commands();
    Ok(SocketResponse::ok(
        None,
        Some(json!({
            "observed": observed,
            "declared": exposed,
            "note": "Tauri has no runtime registry of #[tauri::command] handlers, and its invoke() is frozen so passive capture of frontend calls is impossible. 'observed' aggregates only IPC this tool mediated (invokes issued via manage_ipc, plus emitted/received events) — NOT organic frontend traffic. 'declared' lists commands the app registered via PluginConfig::expose_commands. To discover the backend surface, declare commands or issue invokes through this tool.",
        })),
    ))
}

fn handle_emit<R: Runtime>(
    app: &AppHandle<R>,
    payload: &Value,
) -> Result<SocketResponse, crate::error::Error> {
    let event = match payload.get("event").and_then(|v| v.as_str()) {
        Some(e) if !e.is_empty() => e,
        _ => {
            return Ok(SocketResponse::err(
                None,
                "'event' is required for action=emit".to_string(),
            ));
        }
    };
    let event_payload = payload.get("payload").cloned().unwrap_or(Value::Null);

    let result = if let Some(label) = payload.get("window_label").and_then(|v| v.as_str()) {
        let target = get_emit_target(app, label);
        app.emit_to(&target, event, event_payload.clone())
    } else {
        app.emit(event, event_payload.clone())
    };

    match result {
        Ok(()) => {
            ipc_buffer::global().push(
                "event",
                event.to_string(),
                "emitted",
                None,
                Some(event_payload.to_string()),
                None,
                None,
            );
            Ok(SocketResponse::ok(
                None,
                Some(json!({ "emitted": event })),
            ))
        }
        Err(e) => Ok(SocketResponse::err(
            None,
            format!("Failed to emit event '{}': {}", event, e),
        )),
    }
}

/// Arm a background listener for a named event BEFORE performing an action.
/// MCP tool calls run sequentially, so `wait_event` can't observe an event
/// caused by a later tool call — instead: arm_event → act (click/invoke/...)
/// → check `captured` (kind=event, status=received). Every occurrence while
/// armed is recorded into the IPC buffer; the listener auto-disarms after
/// `timeout_ms` (default 60s, max 5min).
fn handle_arm_event<R: Runtime>(
    app: &AppHandle<R>,
    payload: &Value,
) -> Result<SocketResponse, crate::error::Error> {
    let event = match payload.get("event").and_then(|v| v.as_str()) {
        Some(e) if !e.is_empty() => e.to_string(),
        _ => {
            return Ok(SocketResponse::err(
                None,
                "'event' is required for action=arm_event".to_string(),
            ));
        }
    };
    let duration_ms = payload
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(60_000)
        .min(300_000);

    let event_name = event.clone();
    // listen_any catches both app-wide and window-targeted emissions.
    let listener_id = app.listen_any(event.clone(), move |ev| {
        ipc_buffer::global().push(
            "event",
            event_name.clone(),
            "received",
            None,
            None,
            Some(ev.payload().to_string()),
            None,
        );
    });

    let app_handle = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(duration_ms)).await;
        app_handle.unlisten(listener_id);
    });

    Ok(SocketResponse::ok(
        None,
        Some(json!({
            "armed": event,
            "duration_ms": duration_ms,
        })),
    ))
}

/// Wait (once) for a named Tauri event to fire anywhere in the app —
/// useful for asserting "saving the form emits `user-updated`".
async fn handle_wait_event<R: Runtime>(
    app: &AppHandle<R>,
    payload: &Value,
) -> Result<SocketResponse, crate::error::Error> {
    let event = match payload.get("event").and_then(|v| v.as_str()) {
        Some(e) if !e.is_empty() => e.to_string(),
        _ => {
            return Ok(SocketResponse::err(
                None,
                "'event' is required for action=wait_event".to_string(),
            ));
        }
    };
    let timeout_ms = payload
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(10_000);

    let (tx, rx) = tokio::sync::oneshot::channel();
    let listener_id = app.once(event.clone(), move |ev| {
        let _ = tx.send(ev.payload().to_string());
    });

    match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(event_payload)) => {
            app.unlisten(listener_id);
            ipc_buffer::global().push(
                "event",
                event.clone(),
                "received",
                None,
                None,
                Some(event_payload.clone()),
                None,
            );
            let parsed: Value = serde_json::from_str(&event_payload)
                .unwrap_or(Value::String(event_payload));
            Ok(SocketResponse::ok(
                None,
                Some(json!({ "event": event, "received": true, "payload": parsed })),
            ))
        }
        Ok(Err(_)) => {
            app.unlisten(listener_id);
            Ok(SocketResponse::err(
                None,
                format!("Listener dropped while waiting for event '{}'", event),
            ))
        }
        Err(_) => {
            app.unlisten(listener_id);
            Ok(SocketResponse::ok(
                None,
                Some(json!({
                    "event": event,
                    "received": false,
                    "timed_out_after_ms": timeout_ms,
                })),
            ))
        }
    }
}
