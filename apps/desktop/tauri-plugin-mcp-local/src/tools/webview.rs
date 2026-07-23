use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Runtime};
use uuid::Uuid;

use crate::desktop::get_emit_target;

// ---- Correlation-ID based emit+wait helper ----

/// Emit an event to a webview and wait for a correlated response.
///
/// 1. Generates a UUID correlation ID.
/// 2. Injects `_correlationId` into the JSON payload sent to JS.
/// 3. Registers a one-shot listener on `"{response_event}-{uuid}"` BEFORE emitting.
/// 4. Emits `request_event` with the augmented payload.
/// 5. Awaits up to `timeout` for the JS side to respond on the correlated event.
/// 6. Returns the raw payload string, or an error on timeout / emit failure.
pub async fn emit_and_wait<R: Runtime>(
    app: &AppHandle<R>,
    emit_target: &str,
    request_event: &str,
    response_event: &str,
    mut payload: Value,
    timeout: std::time::Duration,
) -> Result<String, crate::error::Error> {
    let correlation_id = Uuid::new_v4().to_string();

    // Inject the correlation ID into the payload
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "_correlationId".to_string(),
            Value::String(correlation_id.clone()),
        );
    } else {
        // If payload isn't an object, wrap it
        payload = serde_json::json!({
            "_payload": payload,
            "_correlationId": correlation_id.clone(),
        });
    }

    let (tx, rx) = tokio::sync::oneshot::channel();

    // Register correlated listener BEFORE emitting (avoids race condition)
    let correlated_event = format!("{}-{}", response_event, correlation_id);
    let listener_id = app.once(correlated_event, move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    // Emit the request
    if let Err(e) = app.emit_to(emit_target, request_event, payload) {
        app.unlisten(listener_id);
        return Err(crate::error::Error::Anyhow(format!(
            "Failed to emit {} event: {}",
            request_event, e
        )));
    }

    // Await the correlated response with timeout
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(payload)) => {
            // once() auto-unlistens after firing, but we must also unlisten
            // explicitly to prevent the EventId Drop impl from double-unlistening
            app.unlisten(listener_id);
            Ok(payload)
        }
        Ok(Err(_)) => {
            app.unlisten(listener_id);
            // Sender dropped without sending (listener was cleaned up)
            Err(crate::error::Error::Anyhow(format!(
                "Listener dropped before {} response received",
                request_event
            )))
        }
        Err(_) => {
            app.unlisten(listener_id);
            Err(crate::error::Error::Anyhow(format!(
                "Timeout waiting for {} response",
                request_event
            )))
        }
    }
}

// ---- Parse / extract helpers ----

/// Parse a JSON response string from the JS side into a SocketResponse.
/// Handles double-encoded JSON from the Tauri event system.
pub fn parse_js_response(result_string: &str) -> crate::socket_server::SocketResponse {
    let data: Value = serde_json::from_str(result_string)
        .unwrap_or_else(|_| Value::String(result_string.to_string()));

    // If data is a string (double-encoded), parse it again
    let data = if let Some(s) = data.as_str() {
        serde_json::from_str(s).unwrap_or(Value::String(s.to_string()))
    } else {
        data
    };

    let success = data
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if success {
        crate::socket_server::SocketResponse::ok(None, data.get("data").cloned())
    } else {
        crate::socket_server::SocketResponse::err(
            None,
            data.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error"),
        )
    }
}

/// Extract window_label from various payload formats (string or object).
fn extract_window_label(payload: &Value) -> Result<String, crate::error::Error> {
    if payload.is_string() {
        payload
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| crate::error::Error::Anyhow("Invalid string payload".to_string()))
    } else if payload.is_object() {
        payload
            .get("window_label")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                crate::error::Error::Anyhow(
                    "Missing or invalid window_label in payload".to_string(),
                )
            })
    } else {
        Err(crate::error::Error::Anyhow(format!(
            "Invalid payload format: expected string or object with window_label, got {}",
            payload
        )))
    }
}

// ---- Command handlers ----

pub async fn handle_get_dom<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;

    let timeout_secs = payload
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(10);

    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let emit_target = get_emit_target(app, &window_label);

    match emit_and_wait(
        app,
        &emit_target,
        "got-dom-content",
        "got-dom-content-response",
        serde_json::json!("test"),
        std::time::Duration::from_secs(timeout_secs),
    ).await {
        Ok(dom_string) => {
            if dom_string.is_empty() {
                Ok(crate::socket_server::SocketResponse::err(None, "Retrieved DOM string is empty".to_string()))
            } else {
                let data = serde_json::to_value(dom_string).map_err(|e| {
                    crate::error::Error::Anyhow(format!("Failed to serialize response: {}", e))
                })?;
                Ok(crate::socket_server::SocketResponse::ok(None, Some(data)))
            }
        }
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, e.to_string())),
    }
}

/// Handler for get_page_map — returns a structured page map with numbered element refs
pub async fn handle_get_page_map<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;

    let timeout_secs = payload
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(10);

    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let emit_target = get_emit_target(app, &window_label);

    let js_payload = serde_json::json!({
        "includeContent": payload.get("include_content").and_then(|v| v.as_bool()).unwrap_or(true),
        "waitForStable": payload.get("wait_for_stable").and_then(|v| v.as_bool()).unwrap_or(false),
        "quietMs": payload.get("quiet_ms").and_then(|v| v.as_u64()).unwrap_or(300),
        "maxWaitMs": payload.get("max_wait_ms").and_then(|v| v.as_u64()).unwrap_or(3000),
        "interactiveOnly": payload.get("interactive_only").and_then(|v| v.as_bool()).unwrap_or(false),
        "scopeSelector": payload.get("scope_selector"),
        "maxDepth": payload.get("max_depth").and_then(|v| v.as_u64()),
        "delta": payload.get("delta").and_then(|v| v.as_bool()).unwrap_or(false),
        "includeMetadata": payload.get("include_metadata").and_then(|v| v.as_bool()).unwrap_or(true)
    });

    match emit_and_wait(
        app,
        &emit_target,
        "get-page-map",
        "get-page-map-response",
        js_payload,
        std::time::Duration::from_secs(timeout_secs),
    ).await {
        Ok(result_string) => {
            if result_string.is_empty() || result_string == "\"\"" {
                return Ok(crate::socket_server::SocketResponse::err(None, "Page map result is empty".to_string()));
            }

            let data: Value = serde_json::from_str(&result_string)
                .unwrap_or_else(|_| Value::String(result_string));

            let data = if let Some(s) = data.as_str() {
                serde_json::from_str(s).unwrap_or(Value::String(s.to_string()))
            } else {
                data
            };

            // Surface JS-side page-map failures
            let page_map_error = data
                .get("error")
                .and_then(|v| {
                    if v.is_null() {
                        None
                    } else if let Some(s) = v.as_str() {
                        Some(s.trim().to_string())
                    } else {
                        Some(v.to_string())
                    }
                })
                .filter(|s| !s.is_empty());

            if let Some(error_message) = page_map_error {
                return Ok(crate::socket_server::SocketResponse::err(None, format!("Page map generation failed: {}", error_message)));
            }

            Ok(crate::socket_server::SocketResponse::ok(None, Some(data)))
        }
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, format!("Timeout waiting for page map: {}", e))),
    }
}

#[derive(Debug, Deserialize)]
struct GetElementPositionPayload {
    window_label: String,
    selector_type: String,
    selector_value: String,
    #[serde(default)]
    should_click: bool,
    #[serde(default)]
    raw_coordinates: bool,
    #[serde(default)]
    scope_selector: Option<String>,
    #[serde(default)]
    match_mode: Option<String>,
    #[serde(default)]
    nth: Option<u32>,
}

pub async fn handle_get_element_position<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let parsed = serde_json::from_value::<GetElementPositionPayload>(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for get_element_position: {}", e))
    })?;

    let emit_target = get_emit_target(app, &parsed.window_label);

    let js_payload = serde_json::json!({
        "windowLabel": parsed.window_label,
        "selectorType": parsed.selector_type,
        "selectorValue": parsed.selector_value,
        "shouldClick": parsed.should_click,
        "rawCoordinates": parsed.raw_coordinates,
        "scopeSelector": parsed.scope_selector,
        "matchMode": parsed.match_mode,
        "nth": parsed.nth
    });

    match emit_and_wait(
        app,
        &emit_target,
        "get-element-position",
        "get-element-position-response",
        js_payload,
        std::time::Duration::from_secs(5),
    ).await {
        Ok(result) => {
            let result_value: Value = serde_json::from_str(&result).map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to parse result: {}", e))
            })?;

            let success = result_value
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if success {
                Ok(crate::socket_server::SocketResponse::ok(None, Some(result_value.get("data").cloned().unwrap_or(Value::Null))))
            } else {
                let error = result_value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error occurred");

                Ok(crate::socket_server::SocketResponse::err(None, error.to_string()))
            }
        }
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, format!("Timeout waiting for element position result: {}", e))),
    }
}

#[derive(Debug, Deserialize)]
struct SendTextToElementPayload {
    window_label: String,
    selector_type: String,
    selector_value: String,
    text: String,
    #[serde(default = "default_delay_ms")]
    delay_ms: u32,
}

fn default_delay_ms() -> u32 {
    20
}

pub async fn handle_send_text_to_element<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let parsed = serde_json::from_value::<SendTextToElementPayload>(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for send_text_to_element: {}", e))
    })?;

    let emit_target = get_emit_target(app, &parsed.window_label);

    let js_payload = serde_json::json!({
        "selectorType": parsed.selector_type,
        "selectorValue": parsed.selector_value,
        "text": parsed.text,
        "delayMs": parsed.delay_ms
    });

    match emit_and_wait(
        app,
        &emit_target,
        "send-text-to-element",
        "send-text-to-element-response",
        js_payload,
        std::time::Duration::from_secs(30),
    ).await {
        Ok(result) => {
            let result_value: Value = serde_json::from_str(&result).map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to parse result: {}", e))
            })?;

            let success = result_value
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if success {
                Ok(crate::socket_server::SocketResponse::ok(None, Some(result_value.get("data").cloned().unwrap_or(Value::Null))))
            } else {
                let error = result_value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error occurred");

                Ok(crate::socket_server::SocketResponse::err(None, error.to_string()))
            }
        }
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, format!("Timeout waiting for text input completion: {}", e))),
    }
}

/// Handler for get_page_state — lightweight URL/title/readyState check
pub async fn handle_get_page_state<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let emit_target = get_emit_target(app, &window_label);

    match emit_and_wait(
        app,
        &emit_target,
        "get-page-state",
        "get-page-state-response",
        serde_json::json!({}),
        std::time::Duration::from_secs(5),
    ).await {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, format!("Timeout waiting for page state: {}", e))),
    }
}

/// Handler for navigate_back — browser history back/forward/go(n)
pub async fn handle_navigate_back<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let emit_target = get_emit_target(app, &window_label);

    let js_payload = serde_json::json!({
        "direction": payload.get("direction").and_then(|v| v.as_str()).unwrap_or("back"),
        "delta": payload.get("delta").and_then(|v| v.as_i64())
    });

    match emit_and_wait(
        app,
        &emit_target,
        "navigate-back",
        "navigate-back-response",
        js_payload,
        std::time::Duration::from_secs(5),
    ).await {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, format!("Timeout waiting for navigation: {}", e))),
    }
}

/// Handler for scroll_page — scroll by page/half/pixels, to element ref, or to top/bottom
pub async fn handle_scroll_page<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let emit_target = get_emit_target(app, &window_label);

    let js_payload = serde_json::json!({
        "direction": payload.get("direction").and_then(|v| v.as_str()),
        "amount": payload.get("amount"),
        "toRef": payload.get("to_ref").and_then(|v| v.as_i64()),
        "toTop": payload.get("to_top").and_then(|v| v.as_bool()).unwrap_or(false),
        "toBottom": payload.get("to_bottom").and_then(|v| v.as_bool()).unwrap_or(false)
    });

    match emit_and_wait(
        app,
        &emit_target,
        "scroll-page",
        "scroll-page-response",
        js_payload,
        std::time::Duration::from_secs(5),
    ).await {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, format!("Timeout waiting for scroll: {}", e))),
    }
}

/// Handler for fill_form — batch-fill multiple form fields by ref in one call
pub async fn handle_fill_form<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let emit_target = get_emit_target(app, &window_label);

    // Convert snake_case field keys to camelCase for JS side
    let fields = payload.get("fields").cloned().unwrap_or(Value::Array(vec![]));
    let js_fields: Vec<Value> = if let Some(arr) = fields.as_array() {
        arr.iter()
            .map(|f| {
                serde_json::json!({
                    "ref": f.get("ref"),
                    "selectorType": f.get("selector_type"),
                    "selectorValue": f.get("selector_value"),
                    "value": f.get("value"),
                    "clear": f.get("clear")
                })
            })
            .collect()
    } else {
        vec![]
    };

    let js_payload = serde_json::json!({
        "fields": js_fields,
        "submitRef": payload.get("submit_ref").and_then(|v| v.as_i64())
    });

    match emit_and_wait(
        app,
        &emit_target,
        "fill-form",
        "fill-form-response",
        js_payload,
        std::time::Duration::from_secs(30),
    ).await {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, format!("Timeout waiting for form fill: {}", e))),
    }
}

/// Handler for type_into_focused — JS-based typing into the currently focused element
/// Detects element type (input/textarea, Lexical, Slate, contentEditable) and routes
/// to the appropriate JS typing strategy. Solves Lexical/Slate failures with native
/// NSEvent injection by using DOM-level event dispatch instead.
pub async fn handle_type_into_focused<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = payload
        .get("window_label")
        .and_then(|v| v.as_str())
        .unwrap_or("main")
        .to_string();

    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let emit_target = get_emit_target(app, &window_label);

    let text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if text.is_empty() {
        return Ok(crate::socket_server::SocketResponse::err(None, "text parameter is required and must not be empty".to_string()));
    }

    let delay_ms = payload
        .get("delay_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(20);

    let mut js_payload = serde_json::json!({
        "text": text,
        "delayMs": delay_ms
    });
    if let Some(initial_delay) = payload.get("initial_delay_ms").and_then(|v| v.as_u64()) {
        js_payload["initialDelayMs"] = serde_json::json!(initial_delay);
    }

    let initial_delay_ms = payload
        .get("initial_delay_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Allow generous timeout for character-by-character typing + initial delay
    // Use character count (not byte length) to match the guest's per-character pacing
    let timeout_secs = std::cmp::max(
        10,
        (text.chars().count() as u64 * delay_ms + initial_delay_ms) / 1000 + 5,
    );

    match emit_and_wait(
        app,
        &emit_target,
        "type-into-focused",
        "type-into-focused-response",
        js_payload,
        std::time::Duration::from_secs(timeout_secs),
    ).await {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, format!("Timeout waiting for type_into_focused: {}", e))),
    }
}

/// Handler for wait_for — wait for text/element to appear or disappear
pub async fn handle_wait_for<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let emit_target = get_emit_target(app, &window_label);

    let timeout_ms = payload
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(10000);

    let js_payload = serde_json::json!({
        "text": payload.get("text"),
        "selector": payload.get("selector"),
        "ref": payload.get("ref"),
        "state": payload.get("state").and_then(|v| v.as_str()).unwrap_or("visible"),
        "timeoutMs": timeout_ms
    });

    // Rust timeout = JS timeout + 2s buffer
    let rust_timeout_secs = (timeout_ms + 2000) / 1000;

    match emit_and_wait(
        app,
        &emit_target,
        "wait-for",
        "wait-for-response",
        js_payload,
        std::time::Duration::from_secs(rust_timeout_secs),
    ).await {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, format!("Timeout waiting for condition: {}", e))),
    }
}

/// Handler for press_key — dispatches synthetic keyboard events (with
/// modifier flags and default-action emulation) in the webview.
pub async fn handle_press_key<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let emit_target = get_emit_target(app, &window_label);

    let js_payload = serde_json::json!({
        "key": payload.get("key"),
        "modifiers": payload.get("modifiers"),
        "repeat": payload.get("repeat"),
        "selectorType": payload.get("selector_type"),
        "selectorValue": payload.get("selector_value"),
    });

    match emit_and_wait(
        app,
        &emit_target,
        "press-key",
        "press-key-response",
        js_payload,
        std::time::Duration::from_secs(15),
    ).await {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, e.to_string())),
    }
}

/// Handler for set_file_input — attaches base64-encoded files to an
/// `<input type="file">` via DataTransfer in the webview.
pub async fn handle_set_file_input<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let emit_target = get_emit_target(app, &window_label);

    let js_payload = serde_json::json!({
        "selectorType": payload.get("selector_type"),
        "selectorValue": payload.get("selector_value"),
        "files": payload.get("files"),
    });

    // Larger timeout: base64 payloads can be big and decoding takes time
    match emit_and_wait(
        app,
        &emit_target,
        "set-file-input",
        "set-file-input-response",
        js_payload,
        std::time::Duration::from_secs(30),
    ).await {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(None, e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_js_response_success() {
        let input = r#"{"success":true,"data":{"url":"http://example.com"}}"#;
        let resp = parse_js_response(input);
        assert!(resp.success);
        assert!(resp.data.is_some());
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_parse_js_response_failure() {
        let input = r#"{"success":false,"error":"something went wrong"}"#;
        let resp = parse_js_response(input);
        assert!(!resp.success);
        assert!(resp.data.is_none());
        assert_eq!(resp.error.as_deref(), Some("something went wrong"));
    }

    #[test]
    fn test_parse_js_response_double_encoded() {
        // JS sends JSON.stringify(obj) which the event system wraps in quotes
        let inner = r#"{"success":true,"data":{"key":"value"}}"#;
        let double_encoded = serde_json::to_string(inner).unwrap();
        let resp = parse_js_response(&double_encoded);
        assert!(resp.success);
        assert!(resp.data.is_some());
    }

    #[test]
    fn test_parse_js_response_garbage() {
        let resp = parse_js_response("not valid json at all {{{");
        assert!(!resp.success);
        assert_eq!(resp.error.as_deref(), Some("Unknown error"));
    }

    #[test]
    fn test_extract_window_label_string() {
        let payload = Value::String("main".to_string());
        assert_eq!(extract_window_label(&payload).unwrap(), "main");
    }

    #[test]
    fn test_extract_window_label_object() {
        let payload = serde_json::json!({"window_label": "preview"});
        assert_eq!(extract_window_label(&payload).unwrap(), "preview");
    }

    #[test]
    fn test_extract_window_label_invalid() {
        let payload = serde_json::json!(42);
        assert!(extract_window_label(&payload).is_err());
    }
}
