use serde::{Serialize, Serializer};
use serde_json::Value;
use std::fmt;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};

use crate::error::Error;
use crate::models::LocalStorageRequest;
use crate::socket_server::SocketResponse;

// Define a custom error type for localStorage operations
#[derive(Debug)]
pub enum LocalStorageError {
    WebviewOperation(String),
    JavaScriptError(String),
    Timeout(String),
}

// Implement Display for the error
impl fmt::Display for LocalStorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LocalStorageError::WebviewOperation(s) => {
                write!(f, "LocalStorage operation error: {}", s)
            }
            LocalStorageError::JavaScriptError(s) => write!(f, "JavaScript error: {}", s),
            LocalStorageError::Timeout(s) => write!(f, "Operation timed out: {}", s),
        }
    }
}

// Make the error serializable
impl Serialize for LocalStorageError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// Support conversion from timeout error
impl From<mpsc::RecvTimeoutError> for LocalStorageError {
    fn from(err: mpsc::RecvTimeoutError) -> Self {
        LocalStorageError::Timeout(format!(
            "Timeout waiting for localStorage response: {}",
            err
        ))
    }
}
// Handler function for the socket server
pub async fn handle_get_local_storage<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    // Parse params from payload
    let params: LocalStorageRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for localStorage: {}", e)))?;

    // Validate input parameters
    match params.action.as_str() {
        "get" => {
            // No validation needed - if key is None, return all localStorage
        }
        "remove" => {
            if params.key.is_none() {
                return Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some("Key is required for remove operations".to_string()),
                });
            }
        }
        "set" => {
            if params.key.is_none() || params.value.is_none() {
                return Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some("Both key and value are required for set operation".to_string()),
                });
            }
        }
        "clear" | "keys" => {
            // These operations don't need validation
        }
        _ => {
            return Ok(SocketResponse {
                success: false,
                data: None,
                error: Some(format!(
                    "Unsupported localStorage action: {}",
                    params.action
                )),
            });
        }
    };

    // Get the window
    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());
    let _window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    // Call the implementation function with cloned app handle and params
    let result = perform_local_storage_operation(app.clone(), params.clone()).await;

    // Handle the result
    match result {
        Ok(data) => Ok(SocketResponse {
            success: true,
            data: Some(
                serde_json::to_value(data)
                    .map_err(|e| Error::serialization_error(format!("Failed to serialize response: {}", e)))?,
            ),
            error: None,
        }),
        Err(e) => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(e.to_string()),
        }),
    }
}

// Implementation function
async fn perform_local_storage_operation<R: Runtime>(
    app: AppHandle<R>,
    params: LocalStorageRequest,
) -> Result<Value, LocalStorageError> {
    // Get window label
    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Emit event to the window
    app.emit_to(&window_label, "get-local-storage", &params)
        .map_err(|e| LocalStorageError::WebviewOperation(format!("Failed to emit event to {}: {}", window_label, e)))?;

    // Set up channel for response
    let (tx, rx) = mpsc::channel();

    // Listen for response
    app.once("get-local-storage-response", move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Wait for response with timeout
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(result_string) => {
            // Parse the response
            let response: Value = serde_json::from_str(&result_string).map_err(|e| {
                LocalStorageError::JavaScriptError(format!("Failed to parse response: {}", e))
            })?;

            // Check if result contains an error
            if let Some(error) = response.get("error") {
                if let Some(error_str) = error.as_str() {
                    return Err(LocalStorageError::JavaScriptError(error_str.to_string()));
                } else {
                    return Err(LocalStorageError::JavaScriptError(
                        "Unknown error".to_string(),
                    ));
                }
            }

            // Get data from response
            if let Some(data) = response.get("data") {
                Ok(data.clone())
            } else {
                Ok(Value::Null)
            }
        }
        Err(e) => Err(e.into()),
    }
}
