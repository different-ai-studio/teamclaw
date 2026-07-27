use serde::Deserialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Listener, Runtime};

use crate::socket_server::SocketResponse;

#[derive(Debug, Deserialize)]
struct EventsPayload {
    action: String,
    event: Option<String>,
    target: Option<String>,
    payload: Option<Value>,
    duration_ms: Option<u64>,
}

/// Handler for manage_events — emit, listen, sniff Tauri events
pub async fn handle_manage_events<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let parsed: EventsPayload = serde_json::from_value(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for manage_events: {}", e))
    })?;

    match parsed.action.as_str() {
        "emit" => {
            let event_name = parsed.event.ok_or_else(|| {
                crate::error::Error::Anyhow("'event' is required for emit action".to_string())
            })?;
            let event_payload = parsed.payload.unwrap_or(Value::Null);
            app.emit(&event_name, event_payload.clone()).map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to emit event: {}", e))
            })?;
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"emitted": event_name}))))
        }
        "emit_to" => {
            let event_name = parsed.event.ok_or_else(|| {
                crate::error::Error::Anyhow("'event' is required for emit_to action".to_string())
            })?;
            let target = parsed.target.ok_or_else(|| {
                crate::error::Error::Anyhow("'target' is required for emit_to action".to_string())
            })?;
            let event_payload = parsed.payload.unwrap_or(Value::Null);
            app.emit_to(&target, &event_name, event_payload.clone())
                .map_err(|e| {
                    crate::error::Error::Anyhow(format!("Failed to emit_to event: {}", e))
                })?;
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"emitted": event_name, "target": target}))))
        }
        "listen" => {
            let event_name = parsed.event.ok_or_else(|| {
                crate::error::Error::Anyhow("'event' is required for listen action".to_string())
            })?;
            let duration_ms = parsed.duration_ms.unwrap_or(1000).min(30000);
            let collected: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
            let collected_clone = collected.clone();

            let handler = app.listen(&event_name, move |event| {
                let payload_str = event.payload().to_string();
                let payload_val: Value =
                    serde_json::from_str(&payload_str).unwrap_or(Value::String(payload_str));
                if let Ok(mut v) = collected_clone.lock() {
                    v.push(serde_json::json!({
                        "payload": payload_val,
                    }));
                }
            });

            tokio::time::sleep(tokio::time::Duration::from_millis(duration_ms)).await;
            app.unlisten(handler);

            let events = collected.lock().unwrap_or_else(|e| e.into_inner()).clone();
            Ok(SocketResponse::ok(None, Some(serde_json::json!({
                    "event": event_name,
                    "durationMs": duration_ms,
                    "count": events.len(),
                    "events": events,
                }))))
        }
        "sniff" => {
            let event_name = parsed.event.ok_or_else(|| {
                crate::error::Error::Anyhow("'event' is required for sniff action. Use listen_any to capture events from any target for the specified event name.".to_string())
            })?;
            let duration_ms = parsed.duration_ms.unwrap_or(1000).min(30000);
            let collected: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
            let collected_clone = collected.clone();

            let event_name_clone = event_name.clone();
            let handler = app.listen_any(&event_name, move |event| {
                let payload_str = event.payload().to_string();
                let payload_val: Value =
                    serde_json::from_str(&payload_str).unwrap_or(Value::String(payload_str));
                if let Ok(mut v) = collected_clone.lock() {
                    v.push(serde_json::json!({
                        "event": event_name_clone,
                        "payload": payload_val,
                    }));
                }
            });

            tokio::time::sleep(tokio::time::Duration::from_millis(duration_ms)).await;
            app.unlisten(handler);

            let events = collected.lock().unwrap_or_else(|e| e.into_inner()).clone();
            Ok(SocketResponse::ok(None, Some(serde_json::json!({
                    "event": event_name,
                    "durationMs": duration_ms,
                    "count": events.len(),
                    "events": events,
                }))))
        }
        _ => Ok(SocketResponse::err(None, format!(
                "Unknown action '{}'. Valid actions: emit, emit_to, listen, sniff",
                parsed.action
            ))),
    }
}
