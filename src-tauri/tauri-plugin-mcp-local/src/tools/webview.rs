use serde::{Deserialize, Serialize, Serializer}; // Add Deserialize for parsing payload
use serde_json::Value;
use std::fmt;
use std::sync::mpsc;
use tauri::{AppHandle, Error as TauriError, Listener, Manager, Runtime, WebviewWindow};

// Custom error enum for the get_dom_text command
#[derive(Debug)] // Add Serialize for the enum itself if it needs to be directly serialized
// For now, we serialize its string representation
pub enum GetDomError {
    WebviewOperation(String),
    JavaScriptError(String),
    DomIsEmpty,
}

// Implement Display for GetDomError to allow.to_string()
impl fmt::Display for GetDomError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GetDomError::WebviewOperation(s) => write!(f, "Webview operation error: {}", s),
            GetDomError::JavaScriptError(s) => write!(f, "JavaScript execution error: {}", s),
            GetDomError::DomIsEmpty => write!(f, "Retrieved DOM string is empty"),
        }
    }
}

// Implement Serialize for GetDomError so it can be returned to the frontend
impl Serialize for GetDomError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// Automatically convert tauri::Error into GetDomError::WebviewOperation or JavaScriptError
impl From<TauriError> for GetDomError {
    fn from(err: TauriError) -> Self {
        // Basic differentiation, could be more sophisticated if TauriError variants allow
        match err {
            _ => GetDomError::JavaScriptError(err.to_string()), // Default to JS error as eval is involved
        }
    }
}

// Handler function for the getDom command, following the take_screenshot pattern
pub async fn handle_get_dom<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    // Parse the window label from the payload - handle both string and object formats
    let window_label = if payload.is_string() {
        // Direct string format
        payload
            .as_str()
            .ok_or_else(|| {
                crate::error::Error::Anyhow { message: "Invalid string payload for getDom".to_string() }
            })?
            .to_string()
    } else if payload.is_object() {
        // Object with window_label property
        payload
            .get("window_label")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                crate::error::Error::Anyhow {
                    message: "Missing or invalid window_label in payload object".to_string(),
                }
            })?
    } else {
        return Err(crate::error::Error::Anyhow {
            message: format!(
                "Invalid payload format for getDom: expected string or object with window_label, got {}",
                payload
            )
        });
    };

    // Get the window by label using the Manager trait
    let window = app.get_webview_window(&window_label).ok_or_else(|| {
        crate::error::Error::window_not_found(&window_label)
    })?;
    let result = get_dom_text(app.clone(), window).await;
    match result {
        Ok(dom_text) => {
            let data = serde_json::to_value(dom_text).map_err(|e| {
                crate::error::Error::serialization_error(format!("Failed to serialize response: {}", e))
            })?;
            Ok(crate::socket_server::SocketResponse {
                success: true,
                data: Some(data),
                error: None,
            })
        }
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(e.to_string()),
        }),
    }
}
use tauri::Emitter;
#[tauri::command]
pub async fn get_dom_text<R: Runtime>(
    app: AppHandle<R>,
    _window: WebviewWindow<R>,
) -> Result<String, GetDomError> {
    app.emit_to("main", "got-dom-content", "test").unwrap();

    let (tx, rx) = mpsc::channel();

    app.once("got-dom-content-response", move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Wait for the content
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(dom_string) => {
            if dom_string.is_empty() {
                Err(GetDomError::DomIsEmpty)
            } else {
                Ok(dom_string)
            }
        }
        Err(e) => {
            // This error (e: tauri::Error) could be from the eval call itself
            // or an error from the JavaScript execution (Promise rejection).
            Err(GetDomError::from(e))
        }
    }
}

// Second fix: add From implementation for RecvTimeoutError
impl From<mpsc::RecvTimeoutError> for GetDomError {
    fn from(err: mpsc::RecvTimeoutError) -> Self {
        GetDomError::WebviewOperation(format!("Timeout waiting for DOM: {}", err))
    }
}

// Define the structure for get_element_position payload
#[derive(Debug, Deserialize)]
struct GetElementPositionPayload {
    window_label: String,
    selector_type: String,
    selector_value: String,
    #[serde(default)]
    should_click: bool,
    #[serde(default)]
    raw_coordinates: bool,
}

// Handle getting element position
pub async fn handle_get_element_position<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    // Parse the payload
    let payload = serde_json::from_value::<GetElementPositionPayload>(payload).map_err(|e| {
        crate::error::Error::serialization_error(format!("Invalid payload for get_element_position: {}", e))
    })?;

    // Create a channel to receive the result
    let (tx, rx) = mpsc::channel();

    // Event name for the response
    let event_name = "get-element-position-response";

    // Set up the listener for the response
    app.once(event_name, move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Prepare the request payload with selector information
    let js_payload = serde_json::json!({
        "windowLabel": payload.window_label,
        "selectorType": payload.selector_type,
        "selectorValue": payload.selector_value,
        "shouldClick": payload.should_click,
        "rawCoordinates": payload.raw_coordinates
    });

    // Emit the event to the webview
    app.emit_to(&payload.window_label, "get-element-position", js_payload)
        .map_err(|e| {
            crate::error::Error::communication_error_with_context(
                "Failed to emit get-element-position event",
                format!("{}", e),
            )
        })?;

    // Wait for the response with a timeout
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(result) => {
            // Parse the result
            let result_value: Value = serde_json::from_str(&result).map_err(|e| {
                crate::error::Error::serialization_error(format!("Failed to parse result: {}", e))
            })?;

            let success = result_value
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if success {
                Ok(crate::socket_server::SocketResponse {
                    success: true,
                    data: Some(result_value.get("data").cloned().unwrap_or(Value::Null)),
                    error: None,
                })
            } else {
                let error = result_value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error occurred");

                Ok(crate::socket_server::SocketResponse {
                    success: false,
                    data: None,
                    error: Some(error.to_string()),
                })
            }
        }
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!(
                "Timeout waiting for element position result: {}",
                e
            )),
        }),
    }
}

// Define the structure for send_text_to_element payload
#[derive(Debug, Deserialize)]
struct SendTextToElementPayload {
    window_label: String,
    selector_type: String,
    selector_value: String,
    text: String,
    #[serde(default = "default_delay_ms")]
    delay_ms: u32,
}

// Default delay_ms value
fn default_delay_ms() -> u32 {
    20
}

// Handle sending text to an element
pub async fn handle_send_text_to_element<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    // Parse the payload
    let payload = serde_json::from_value::<SendTextToElementPayload>(payload).map_err(|e| {
        crate::error::Error::serialization_error(format!("Invalid payload for send_text_to_element: {}", e))
    })?;


    // Create a channel to receive the result
    let (tx, rx) = mpsc::channel();

    // Event name for the response
    let event_name = "send-text-to-element-response";

    // Set up the listener for the response
    app.once(event_name, move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Prepare the request payload
    let js_payload = serde_json::json!({
        "selectorType": payload.selector_type,
        "selectorValue": payload.selector_value,
        "text": payload.text,
        "delayMs": payload.delay_ms
    });

    // Emit the event to the webview
    app.emit_to(&payload.window_label, "send-text-to-element", js_payload)
        .map_err(|e| {
            crate::error::Error::communication_error_with_context(
                "Failed to emit send-text-to-element event",
                format!("{}", e),
            )
        })?;

    // Wait for the response with a timeout
    match rx.recv_timeout(std::time::Duration::from_secs(30)) {
        // Longer timeout for typing text
        Ok(result) => {
            // Parse the result
            let result_value: Value = serde_json::from_str(&result).map_err(|e| {
                crate::error::Error::serialization_error(format!("Failed to parse result: {}", e))
            })?;

            let success = result_value
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if success {
                Ok(crate::socket_server::SocketResponse {
                    success: true,
                    data: Some(result_value.get("data").cloned().unwrap_or(Value::Null)),
                    error: None,
                })
            } else {
                let error = result_value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error occurred");

                Ok(crate::socket_server::SocketResponse {
                    success: false,
                    data: None,
                    error: Some(error.to_string()),
                })
            }
        }
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Timeout waiting for text input completion: {}", e)),
        }),
    }
}
