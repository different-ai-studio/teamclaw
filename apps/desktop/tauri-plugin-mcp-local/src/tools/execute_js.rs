use serde::{Serialize, Serializer};
use serde_json::Value;
use std::fmt;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Listener, Manager, Runtime};

use crate::error::Error;
use crate::socket_server::SocketResponse;

// Define a custom error type for JavaScript execution operations
#[derive(Debug)]
pub enum ExecuteJsError {
    WebviewOperation(String),
    JavaScriptError(String),

    Timeout(String),
}

// Implement Display for the error
impl fmt::Display for ExecuteJsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ExecuteJsError::WebviewOperation(s) => write!(f, "JavaScript execution error: {}", s),
            ExecuteJsError::JavaScriptError(s) => write!(f, "JavaScript error: {}", s),
            ExecuteJsError::Timeout(s) => write!(f, "Operation timed out: {}", s),
        }
    }
}

// Make the error serializable
impl Serialize for ExecuteJsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// Support conversion from timeout error
impl From<mpsc::RecvTimeoutError> for ExecuteJsError {
    fn from(err: mpsc::RecvTimeoutError) -> Self {
        ExecuteJsError::Timeout(format!("Timeout waiting for execute-js response: {}", err))
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExecuteJsRequest {
    window_label: Option<String>,
    code: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ExecuteJsResponse {
    result: String,
    #[serde(rename = "type")]
    result_type: String,
}

pub async fn handle_execute_js<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: ExecuteJsRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for executeJs: {}", e)))?;

    // Get the window label or use "main" as default
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Verify the window exists
    let _window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    // Execute JavaScript and get the result
    let result = execute_js_in_window(app.clone(), request).await;

    // Handle the result
    match result {
        Ok(response) => {
            // Serialize the response
            let data = serde_json::to_value(response).map_err(|e| {
                Error::serialization_error(format!("Failed to serialize response: {}", e))
            })?;

            Ok(SocketResponse {
                success: true,
                data: Some(data),
                error: None,
            })
        }
        Err(e) => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(e.to_string()),
        }),
    }
}

// Helper function to execute JS in a window and await response.
// Uses webview.eval() with an inline wrapper that emits the result back via Tauri event.
// This does NOT require any pre-installed frontend listener — the wrapper is self-contained.
async fn execute_js_in_window<R: Runtime>(
    app: AppHandle<R>,
    params: ExecuteJsRequest,
) -> Result<ExecuteJsResponse, ExecuteJsError> {
    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    let timeout = Duration::from_millis(params.timeout_ms.unwrap_or(10000));

    let webview = app.get_webview_window(&window_label).ok_or_else(|| {
        ExecuteJsError::WebviewOperation(format!("Window '{}' not found", window_label))
    })?;

    // Generate unique event name for this request
    let event_name = format!(
        "__exec_js_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );

    // Build a self-contained JS wrapper:
    // 1. eval the user's code
    // 2. stringify the result
    // 3. emit a Tauri event with the result (using __TAURI_INTERNALS__)
    let escaped_code = serde_json::to_string(&params.code).unwrap_or_else(|_| "\"\"".to_string());
    let escaped_event = serde_json::to_string(&event_name).unwrap_or_else(|_| "\"\"".to_string());

    let wrapper = format!(
        r#"(function() {{
    try {{
        var __r = (0, eval)({code});
        var __s = (typeof __r === 'object' && __r !== null) ? JSON.stringify(__r) : String(__r);
        var __t = typeof __r;
        if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
            window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
                event: {event},
                payload: JSON.stringify({{ result: __s, type: __t }})
            }});
        }}
    }} catch (__e) {{
        if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
            window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
                event: {event},
                payload: JSON.stringify({{ error: String(__e) }})
            }});
        }}
    }}
}})()"#,
        code = escaped_code,
        event = escaped_event,
    );

    // Set up channel to receive the response
    let (tx, rx) = mpsc::channel();
    app.once(&event_name, move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    // Execute the wrapped JS
    webview
        .eval(&wrapper)
        .map_err(|e| ExecuteJsError::WebviewOperation(format!("Failed to eval JS: {}", e)))?;

    // Wait for the response
    match rx.recv_timeout(timeout) {
        Ok(raw) => {
            // The payload comes double-serialized: first as the event payload string,
            // then as the JSON we built in JS
            let inner: String = serde_json::from_str(&raw).unwrap_or(raw.clone());
            let response: Value = serde_json::from_str(&inner).map_err(|e| {
                ExecuteJsError::JavaScriptError(format!(
                    "Failed to parse response: {} (raw: {})",
                    e,
                    &raw[..raw.len().min(200)]
                ))
            })?;

            if let Some(error) = response.get("error")
                && let Some(error_str) = error.as_str()
            {
                return Err(ExecuteJsError::JavaScriptError(error_str.to_string()));
            }

            let result = response
                .get("result")
                .and_then(|r| r.as_str())
                .unwrap_or("[Result could not be stringified]")
                .to_string();

            let result_type = response
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .to_string();

            Ok(ExecuteJsResponse {
                result,
                result_type,
            })
        }
        Err(_) => Err(ExecuteJsError::Timeout(
            "Timeout waiting for execute-js response".to_string(),
        )),
    }
}
