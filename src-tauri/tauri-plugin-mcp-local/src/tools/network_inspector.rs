use serde::{Serialize, Serializer};
use serde_json::Value;
use std::fmt;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};

use crate::error::Error;
use crate::socket_server::SocketResponse;

// HTTP method enumeration
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Delete,
    Patch,
    Head,
    Options,
    Trace,
    Connect,
}

#[allow(dead_code)]
impl HttpMethod {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_uppercase().as_str() {
            "GET" => Some(HttpMethod::Get),
            "POST" => Some(HttpMethod::Post),
            "PUT" => Some(HttpMethod::Put),
            "DELETE" => Some(HttpMethod::Delete),
            "PATCH" => Some(HttpMethod::Patch),
            "HEAD" => Some(HttpMethod::Head),
            "OPTIONS" => Some(HttpMethod::Options),
            "TRACE" => Some(HttpMethod::Trace),
            "CONNECT" => Some(HttpMethod::Connect),
            _ => None,
        }
    }
}

// Request type enumeration
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum RequestType {
    Fetch,
    Xhr,
}

#[allow(dead_code)]
impl RequestType {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "fetch" => Some(RequestType::Fetch),
            "xhr" => Some(RequestType::Xhr),
            _ => None,
        }
    }
}

// Define a custom error type for network inspector operations
#[derive(Debug)]
pub enum NetworkInspectorError {
    WebviewOperation(String),
    TimeoutError(String),
    ParseError(String),
}

// Implement Display for the error
impl fmt::Display for NetworkInspectorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NetworkInspectorError::WebviewOperation(s) => write!(f, "Network operation error: {}", s),
            NetworkInspectorError::TimeoutError(s) => write!(f, "Operation timed out: {}", s),
            NetworkInspectorError::ParseError(s) => write!(f, "Parse error: {}", s),
        }
    }
}

// Make the error serializable
impl Serialize for NetworkInspectorError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// Support conversion from timeout error
impl From<mpsc::RecvTimeoutError> for NetworkInspectorError {
    fn from(err: mpsc::RecvTimeoutError) -> Self {
        NetworkInspectorError::TimeoutError(format!(
            "Timeout waiting for network inspector response: {}",
            err
        ))
    }
}

// Request headers representation
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HeadersMap {
    #[serde(flatten)]
    pub headers: std::collections::HashMap<String, String>,
}

// Single network request entry
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NetworkRequest {
    pub id: String,
    pub url: String,
    pub method: String,
    pub request_type: String, // "fetch" or "xhr"
    pub status_code: Option<u16>,
    pub request_headers: std::collections::HashMap<String, String>,
    pub response_headers: std::collections::HashMap<String, String>,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
    pub error: Option<String>,
    pub start_time_ms: u64,
    pub end_time_ms: Option<u64>,
    pub duration_ms: Option<u64>,
}

// Request filter for querying
#[derive(Debug, Clone, serde::Deserialize)]
pub struct NetworkRequestFilter {
    pub url_pattern: Option<String>,
    pub method: Option<String>,
    pub status_code: Option<u16>,
    pub min_duration_ms: Option<u64>,
    pub max_duration_ms: Option<u64>,
    pub request_type: Option<String>,
    pub start_time_ms: Option<u64>,
    pub end_time_ms: Option<u64>,
    pub limit: Option<usize>,
}

// Request model for network inspection
#[derive(Debug, Clone, serde::Deserialize)]
pub struct NetworkInspectorRequest {
    pub window_label: Option<String>,
    pub action: String, // "get_requests", "clear_requests", "start_capture", "stop_capture"
    pub filter: Option<NetworkRequestFilter>,
}

// Response model for network requests
#[derive(Debug, serde::Serialize)]
pub struct NetworkInspectorResponse {
    pub requests: Vec<NetworkRequest>,
    pub total_count: usize,
    pub returned_count: usize,
    pub capture_active: bool,
}

/// Handler function for network inspection
pub async fn handle_network_inspector<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: NetworkInspectorRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for network inspector: {}", e)))?;

    // Get the window label or use "main" as default
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Verify the window exists
    let _window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    // Handle different actions
    let result = match request.action.as_str() {
        "get_requests" => retrieve_network_requests(app.clone(), request).await,
        "clear_requests" => clear_network_requests(app.clone(), request).await,
        "start_capture" => start_network_capture(app.clone(), request).await,
        "stop_capture" => stop_network_capture(app.clone(), request).await,
        _ => Err(NetworkInspectorError::ParseError(format!(
            "Unknown action: {}",
            request.action
        ))),
    };

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

/// Inject the network capture script into the webview
pub async fn handle_inject_network_capture<R: Runtime>(
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
        .emit("inject-network-capture", ())
        .map_err(|e| Error::communication_error_with_context(
            "Failed to emit injection event",
            format!("window: {}, error: {}", window_label, e),
        ))?;

    Ok(SocketResponse {
        success: true,
        data: Some(serde_json::json!({"message": "Network capture injected"})),
        error: None,
    })
}

/// Helper function to retrieve network requests from the webview
async fn retrieve_network_requests<R: Runtime>(
    app: AppHandle<R>,
    request: NetworkInspectorRequest,
) -> Result<NetworkInspectorResponse, NetworkInspectorError> {
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    let filter = request.filter.unwrap_or_else(|| NetworkRequestFilter {
        url_pattern: None,
        method: None,
        status_code: None,
        min_duration_ms: None,
        max_duration_ms: None,
        request_type: None,
        start_time_ms: None,
        end_time_ms: None,
        limit: Some(100),
    });

    // Build the filter payload
    let filter_payload = serde_json::json!({
        "url_pattern": filter.url_pattern,
        "method": filter.method,
        "status_code": filter.status_code,
        "min_duration_ms": filter.min_duration_ms,
        "max_duration_ms": filter.max_duration_ms,
        "request_type": filter.request_type,
        "start_time_ms": filter.start_time_ms,
        "end_time_ms": filter.end_time_ms,
        "limit": filter.limit.unwrap_or(100),
    });

    // Emit event to retrieve network requests from webview
    app.emit_to(&window_label, "get-network-requests", filter_payload)
        .map_err(|e| NetworkInspectorError::WebviewOperation(format!("Failed to emit event: {}", e)))?;

    // Set up channel for response
    let (tx, rx) = mpsc::channel::<String>();

    // Listen for response
    app.once("get-network-requests-response", move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Wait for response with timeout (15 seconds for potentially large responses)
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(result_string) => {
            // Parse the response
            let response: Value = serde_json::from_str(&result_string)
                .map_err(|e| NetworkInspectorError::ParseError(format!("Failed to parse response: {}", e)))?;

            // Check if result contains an error
            if let Some(error) = response.get("error") {
                if let Some(error_str) = error.as_str() {
                    return Err(NetworkInspectorError::WebviewOperation(error_str.to_string()));
                }
            }

            // Extract requests array from response
            let requests: Vec<NetworkRequest> = response
                .get("requests")
                .and_then(|r| serde_json::from_value(r.clone()).ok())
                .unwrap_or_default();

            let total_count = response
                .get("total_count")
                .and_then(|c| c.as_u64())
                .map(|c| c as usize)
                .unwrap_or(requests.len());

            let returned_count = requests.len();

            let capture_active = response
                .get("capture_active")
                .and_then(|c| c.as_bool())
                .unwrap_or(false);

            Ok(NetworkInspectorResponse {
                requests,
                total_count,
                returned_count,
                capture_active,
            })
        }
        Err(e) => Err(e.into()),
    }
}

/// Helper function to clear network requests from the webview
async fn clear_network_requests<R: Runtime>(
    app: AppHandle<R>,
    request: NetworkInspectorRequest,
) -> Result<NetworkInspectorResponse, NetworkInspectorError> {
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Emit event to clear network requests
    app.emit_to(&window_label, "clear-network-requests", ())
        .map_err(|e| NetworkInspectorError::WebviewOperation(format!("Failed to emit event: {}", e)))?;

    Ok(NetworkInspectorResponse {
        requests: vec![],
        total_count: 0,
        returned_count: 0,
        capture_active: true,
    })
}

/// Helper function to start network capture
async fn start_network_capture<R: Runtime>(
    app: AppHandle<R>,
    request: NetworkInspectorRequest,
) -> Result<NetworkInspectorResponse, NetworkInspectorError> {
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Emit event to start capture
    app.emit_to(&window_label, "start-network-capture", ())
        .map_err(|e| NetworkInspectorError::WebviewOperation(format!("Failed to emit event: {}", e)))?;

    Ok(NetworkInspectorResponse {
        requests: vec![],
        total_count: 0,
        returned_count: 0,
        capture_active: true,
    })
}

/// Helper function to stop network capture
async fn stop_network_capture<R: Runtime>(
    app: AppHandle<R>,
    request: NetworkInspectorRequest,
) -> Result<NetworkInspectorResponse, NetworkInspectorError> {
    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Emit event to stop capture
    app.emit_to(&window_label, "stop-network-capture", ())
        .map_err(|e| NetworkInspectorError::WebviewOperation(format!("Failed to emit event: {}", e)))?;

    Ok(NetworkInspectorResponse {
        requests: vec![],
        total_count: 0,
        returned_count: 0,
        capture_active: false,
    })
}
