use serde::{Serialize, Serializer};
use serde_json::Value;
use std::fmt;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};

use crate::error::Error;
use crate::socket_server::SocketResponse;

// Define a custom error type for storage inspector operations
#[derive(Debug)]
pub enum StorageInspectorError {
    WebviewOperation(String),
    JavaScriptError(String),
    Timeout(String),
}

// Implement Display for the error
impl fmt::Display for StorageInspectorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StorageInspectorError::WebviewOperation(s) => {
                write!(f, "Storage operation error: {}", s)
            }
            StorageInspectorError::JavaScriptError(s) => write!(f, "JavaScript error: {}", s),
            StorageInspectorError::Timeout(s) => write!(f, "Operation timed out: {}", s),
        }
    }
}

// Make the error serializable
impl Serialize for StorageInspectorError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// Support conversion from timeout error
impl From<mpsc::RecvTimeoutError> for StorageInspectorError {
    fn from(err: mpsc::RecvTimeoutError) -> Self {
        StorageInspectorError::Timeout(format!(
            "Timeout waiting for storage inspector response: {}",
            err
        ))
    }
}

// Storage types
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StorageType {
    LocalStorage,
    SessionStorage,
    IndexedDB,
}

#[allow(dead_code)]
impl StorageType {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "localstorage" => Some(StorageType::LocalStorage),
            "sessionstorage" => Some(StorageType::SessionStorage),
            "indexeddb" => Some(StorageType::IndexedDB),
            _ => None,
        }
    }
}

// Storage item (key-value pair)
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct StorageItem {
    pub key: String,
    pub value: Value,
    pub size_bytes: usize,
}

// IndexedDB object store info
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct IndexedDBStore {
    pub name: String,
    pub key_path: Option<Value>,
    pub auto_increment: bool,
    pub indexes: Vec<String>,
    pub item_count: usize,
}

// IndexedDB database info
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct IndexedDBDatabase {
    pub name: String,
    pub version: u32,
    pub stores: Vec<IndexedDBStore>,
}

// Storage query result
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct StorageQueryResult {
    pub storage_type: String,
    pub items: Vec<StorageItem>,
    pub total_items: usize,
    pub total_size_bytes: usize,
    pub paginated: bool,
    pub page: usize,
    pub page_size: usize,
}

// IndexedDB query result
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct IndexedDBQueryResult {
    pub databases: Vec<IndexedDBDatabase>,
    pub items_by_store: std::collections::HashMap<String, Vec<StorageItem>>,
    pub total_items: usize,
    pub total_size_bytes: usize,
}

// Request model for storage inspection
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct StorageInspectorRequest {
    pub window_label: Option<String>,
    pub action: String, // "get_storage", "clear_storage", "list_indexeddb", "query_indexeddb"
    pub storage_type: Option<String>, // "localStorage", "sessionStorage", "indexedDB"
    pub key_pattern: Option<String>, // regex or substring for filtering
    pub page: Option<usize>,
    pub page_size: Option<usize>,
    pub db_name: Option<String>, // for IndexedDB operations
    pub store_name: Option<String>, // for IndexedDB operations
}

// Handler function for the socket server
pub async fn handle_get_storage_inspector<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    // Parse params from payload
    let params: StorageInspectorRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for storage inspector: {}", e)))?;

    // Validate input parameters
    match params.action.as_str() {
        "get_storage" => {
            if params.storage_type.is_none() {
                return Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some("storage_type is required for get_storage action".to_string()),
                });
            }
        }
        "clear_storage" => {
            if params.storage_type.is_none() {
                return Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some("storage_type is required for clear_storage action".to_string()),
                });
            }
        }
        "list_indexeddb" => {
            // No validation needed
        }
        "query_indexeddb" => {
            if params.db_name.is_none() || params.store_name.is_none() {
                return Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some("db_name and store_name are required for query_indexeddb action".to_string()),
                });
            }
        }
        _ => {
            return Ok(SocketResponse {
                success: false,
                data: None,
                error: Some(format!("Unsupported storage inspector action: {}", params.action)),
            });
        }
    }

    // Get the window
    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());
    let _window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    // Call the implementation function with cloned app handle and params
    let result = perform_storage_inspector_operation(app.clone(), params.clone()).await;

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
async fn perform_storage_inspector_operation<R: Runtime>(
    app: AppHandle<R>,
    params: StorageInspectorRequest,
) -> Result<Value, StorageInspectorError> {
    // Get window label
    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Emit event to the window
    app.emit_to(&window_label, "inspect-storage", &params)
        .map_err(|e| StorageInspectorError::WebviewOperation(format!("Failed to emit event: {}", e)))?;

    // Set up channel for response
    let (tx, rx) = mpsc::channel();

    // Listen for response
    app.once("inspect-storage-response", move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Wait for response with timeout (increased to 10 seconds for IndexedDB operations)
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(result_string) => {
            // Parse the response
            let response: Value = serde_json::from_str(&result_string).map_err(|e| {
                StorageInspectorError::JavaScriptError(format!("Failed to parse response: {}", e))
            })?;

            // Check if result contains an error
            if let Some(error) = response.get("error") {
                if let Some(error_str) = error.as_str() {
                    return Err(StorageInspectorError::JavaScriptError(error_str.to_string()));
                } else {
                    return Err(StorageInspectorError::JavaScriptError(
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
