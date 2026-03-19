use serde::{Serialize, Serializer};
use serde_json::Value;
use std::fmt;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};

use crate::error::Error;
use crate::socket_server::SocketResponse;

// Error type enumeration
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ErrorType {
    Uncaught,
    UnhandledRejection,
    ReactBoundary,
}

#[allow(dead_code)]
impl ErrorType {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "uncaught" => Some(ErrorType::Uncaught),
            "unhandledrejection" => Some(ErrorType::UnhandledRejection),
            "reactboundary" => Some(ErrorType::ReactBoundary),
            _ => None,
        }
    }
}

// Define a custom error type for error tracking operations
#[derive(Debug)]
pub enum ErrorTrackerError {
    WebviewOperation(String),
    TimeoutError(String),
    ParseError(String),
}

// Implement Display for the error
impl fmt::Display for ErrorTrackerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErrorTrackerError::WebviewOperation(s) => write!(f, "Error tracking operation error: {}", s),
            ErrorTrackerError::TimeoutError(s) => write!(f, "Operation timed out: {}", s),
            ErrorTrackerError::ParseError(s) => write!(f, "Parse error: {}", s),
        }
    }
}

// Make the error serializable
impl Serialize for ErrorTrackerError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// Support conversion from timeout error
impl From<mpsc::RecvTimeoutError> for ErrorTrackerError {
    fn from(err: mpsc::RecvTimeoutError) -> Self {
        ErrorTrackerError::TimeoutError(format!(
            "Timeout waiting for error tracker response: {}",
            err
        ))
    }
}

// Stack frame representing a single line in a stack trace
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StackFrame {
    pub function_name: Option<String>,
    pub file_name: Option<String>,
    pub line_number: Option<u32>,
    pub column_number: Option<u32>,
    pub source_mapped_file: Option<String>,
    pub source_mapped_line: Option<u32>,
    pub source_mapped_column: Option<u32>,
}

// Single exception/error entry
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExceptionEntry {
    pub id: String,
    pub error_type: String, // "uncaught", "unhandledrejection", "reactboundary"
    pub message: String,
    pub stack_trace: Vec<StackFrame>,
    pub first_occurrence_ms: u64,
    pub last_occurrence_ms: u64,
    pub frequency: u32,
    pub error_details: Option<String>,
}

// Request for retrieving exceptions
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ErrorTrackerRequest {
    pub window_label: Option<String>,
    pub error_type: Option<String>, // "uncaught", "unhandledrejection", "reactboundary", or "all"
    pub message_pattern: Option<String>,
    pub start_time_ms: Option<u64>,
    pub end_time_ms: Option<u64>,
    pub limit: Option<usize>,
}

// Response model for exceptions
#[derive(Debug, serde::Serialize)]
pub struct ErrorTrackerResponse {
    pub exceptions: Vec<ExceptionEntry>,
    pub total_count: usize,
    pub returned_count: usize,
}

// Request to inject error tracking script
#[derive(Debug, Clone, serde::Deserialize)]
pub struct InjectErrorTrackerRequest {
    pub window_label: Option<String>,
    pub circular_buffer_size: Option<usize>,
}

// Response to inject error tracking script
#[derive(Debug, serde::Serialize)]
pub struct InjectErrorTrackerResponse {
    pub message: String,
    pub circular_buffer_size: usize,
}

/// Handler function for retrieving tracked exceptions
pub async fn handle_get_exceptions<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: ErrorTrackerRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for error tracker: {}", e)))?;

    // Get the window label or use "main" as default
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Verify the window exists
    let _window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    // Get exceptions from the window
    let result = retrieve_exceptions(app.clone(), request).await;

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

/// Handler function to inject error tracking script
pub async fn handle_inject_error_tracker<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: InjectErrorTrackerRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for error tracker injection: {}", e)))?;

    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Verify the window exists
    let window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    let circular_buffer_size = request.circular_buffer_size.unwrap_or(1000);

    // Send injection event to the window
    window
        .emit("inject-error-tracker", serde_json::json!({
            "circular_buffer_size": circular_buffer_size
        }))
        .map_err(|e| Error::communication_error_with_context(
            "Failed to emit injection event",
            format!("window: {}, error: {}", window_label, e),
        ))?;

    Ok(SocketResponse {
        success: true,
        data: Some(serde_json::to_value(InjectErrorTrackerResponse {
            message: "Error tracking script injected successfully".to_string(),
            circular_buffer_size,
        }).unwrap()),
        error: None,
    })
}

/// Handler function to clear exceptions
pub async fn handle_clear_exceptions<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    #[derive(serde::Deserialize)]
    pub struct ClearRequest {
        window_label: Option<String>,
    }

    let request: ClearRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for clear exceptions: {}", e)))?;

    let window_label = request
        .window_label
        .unwrap_or_else(|| "main".to_string());

    // Verify the window exists
    let window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    // Send clear event to the window
    window
        .emit("clear-exceptions", ())
        .map_err(|e| Error::communication_error_with_context(
            "Failed to emit clear event",
            format!("window: {}, error: {}", window_label, e),
        ))?;

    Ok(SocketResponse {
        success: true,
        data: Some(serde_json::json!({"message": "Exceptions cleared"})),
        error: None,
    })
}

/// Helper function to retrieve exceptions from the webview
async fn retrieve_exceptions<R: Runtime>(
    app: AppHandle<R>,
    request: ErrorTrackerRequest,
) -> Result<ErrorTrackerResponse, ErrorTrackerError> {
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Build the filter payload
    let filter_payload = serde_json::json!({
        "error_type": request.error_type.clone(),
        "message_pattern": request.message_pattern.clone(),
        "start_time_ms": request.start_time_ms,
        "end_time_ms": request.end_time_ms,
        "limit": request.limit.unwrap_or(1000),
    });

    // Emit event to retrieve exceptions from webview
    app.emit_to(&window_label, "get-exceptions", filter_payload)
        .map_err(|e| ErrorTrackerError::WebviewOperation(format!("Failed to emit event: {}", e)))?;

    // Set up channel for response
    let (tx, rx) = mpsc::channel();

    // Listen for response
    app.once("get-exceptions-response", move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Wait for response with timeout (10 seconds)
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(result_string) => {
            // Parse the response
            let response: Value = serde_json::from_str(&result_string)
                .map_err(|e| ErrorTrackerError::ParseError(format!("Failed to parse response: {}", e)))?;

            // Check if result contains an error
            if let Some(error) = response.get("error") {
                if let Some(error_str) = error.as_str() {
                    return Err(ErrorTrackerError::WebviewOperation(error_str.to_string()));
                }
            }

            // Extract exceptions array from response
            let exceptions: Vec<ExceptionEntry> = response
                .get("exceptions")
                .and_then(|e| serde_json::from_value(e.clone()).ok())
                .unwrap_or_default();

            let total_count = response
                .get("total_count")
                .and_then(|c| c.as_u64())
                .map(|c| c as usize)
                .unwrap_or(exceptions.len());

            let returned_count = exceptions.len();

            Ok(ErrorTrackerResponse {
                exceptions,
                total_count,
                returned_count,
            })
        }
        Err(e) => Err(e.into()),
    }
}
