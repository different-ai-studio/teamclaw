use serde::{Serialize, Serializer};
use serde_json::Value;
use std::fmt;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};

use crate::error::Error;
use crate::socket_server::SocketResponse;

// Console log level enumeration
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "debug" => Some(LogLevel::Debug),
            "info" => Some(LogLevel::Info),
            "warn" => Some(LogLevel::Warn),
            "error" => Some(LogLevel::Error),
            "all" => None, // Special value to indicate all levels
            _ => None,
        }
    }
}

// Define a custom error type for console log operations
#[derive(Debug)]
pub enum ConsoleLogsError {
    WebviewOperation(String),
    TimeoutError(String),
    ParseError(String),
}

// Implement Display for the error
impl fmt::Display for ConsoleLogsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConsoleLogsError::WebviewOperation(s) => write!(f, "Console operation error: {}", s),
            ConsoleLogsError::TimeoutError(s) => write!(f, "Operation timed out: {}", s),
            ConsoleLogsError::ParseError(s) => write!(f, "Parse error: {}", s),
        }
    }
}

// Make the error serializable
impl Serialize for ConsoleLogsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// Support conversion from timeout error
impl From<mpsc::RecvTimeoutError> for ConsoleLogsError {
    fn from(err: mpsc::RecvTimeoutError) -> Self {
        ConsoleLogsError::TimeoutError(format!(
            "Timeout waiting for console logs response: {}",
            err
        ))
    }
}

// Request model for console logs
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ConsoleLogsRequest {
    window_label: Option<String>,
    level: Option<String>, // "debug", "info", "warn", "error", or "all"
    start_time_ms: Option<u64>,
    end_time_ms: Option<u64>,
    limit: Option<usize>,
}

// Single console log entry
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConsoleLogEntry {
    pub timestamp: u64,
    pub level: String,
    pub message: String,
    pub args: Vec<String>,
}

// Response model for console logs
#[derive(Debug, serde::Serialize)]
pub struct ConsoleLogsResponse {
    pub logs: Vec<ConsoleLogEntry>,
    pub total_count: usize,
    pub returned_count: usize,
}

/// Handler function for retrieving console logs
pub async fn handle_get_console_logs<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: ConsoleLogsRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for console logs: {}", e)))?;

    // Get the window label or use "main" as default
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Verify the window exists
    let _window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    // Get console logs from the window
    let result = retrieve_console_logs(app.clone(), request).await;

    // Handle the result
    match result {
        Ok(response) => {
            let data = serde_json::to_value(response)
                .map_err(|e| Error::serialization_error(format!("Failed to serialize response: {}", e)))?;

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

/// Inject the console capture script into the webview
pub async fn handle_inject_console_capture<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    #[derive(serde::Deserialize)]
    pub struct InjectionRequest {
        window_label: Option<String>,
    }

    let request: InjectionRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for injection: {}", e)))?;

    let window_label = request
        .window_label
        .unwrap_or_else(|| "main".to_string());

    // Verify the window exists
    let window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    // Send injection event to the window
    window
        .emit("inject-console-capture", ())
        .map_err(|e| Error::communication_error_with_context(
            "Failed to emit injection event",
            format!("window: {}, error: {}", window_label, e),
        ))?;

    Ok(SocketResponse {
        success: true,
        data: Some(serde_json::json!({"message": "Console capture injected"})),
        error: None,
    })
}

/// Helper function to retrieve console logs from the webview
async fn retrieve_console_logs<R: Runtime>(
    app: AppHandle<R>,
    request: ConsoleLogsRequest,
) -> Result<ConsoleLogsResponse, ConsoleLogsError> {
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Parse log level filter
    let _log_level_filter = request.level.as_ref().and_then(|l| LogLevel::from_str(l));

    // Build the filter payload
    let filter_payload = serde_json::json!({
        "level": request.level.clone(),
        "start_time_ms": request.start_time_ms,
        "end_time_ms": request.end_time_ms,
        "limit": request.limit.unwrap_or(1000),
    });

    // Emit event to retrieve console logs from webview
    app.emit_to(&window_label, "get-console-logs", filter_payload)
        .map_err(|e| ConsoleLogsError::WebviewOperation(format!("Failed to emit event: {}", e)))?;

    // Set up channel for response
    let (tx, rx) = mpsc::channel();

    // Listen for response
    app.once("get-console-logs-response", move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Wait for response with timeout (10 seconds for potentially large responses)
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(result_string) => {
            // Parse the response
            let response: Value = serde_json::from_str(&result_string)
                .map_err(|e| ConsoleLogsError::ParseError(format!("Failed to parse response: {}", e)))?;

            // Check if result contains an error
            if let Some(error) = response.get("error") {
                if let Some(error_str) = error.as_str() {
                    return Err(ConsoleLogsError::WebviewOperation(error_str.to_string()));
                }
            }

            // Extract logs array from response
            let logs: Vec<ConsoleLogEntry> = response
                .get("logs")
                .and_then(|l| serde_json::from_value(l.clone()).ok())
                .unwrap_or_default();

            let total_count = response
                .get("total_count")
                .and_then(|c| c.as_u64())
                .map(|c| c as usize)
                .unwrap_or(logs.len());

            let returned_count = logs.len();

            Ok(ConsoleLogsResponse {
                logs,
                total_count,
                returned_count,
            })
        }
        Err(e) => Err(e.into()),
    }
}
