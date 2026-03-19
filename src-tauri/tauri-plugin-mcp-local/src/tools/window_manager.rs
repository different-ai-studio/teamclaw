use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::TauriMcpExt;
use crate::error::Error;
use crate::models::WindowManagerRequest;
use crate::socket_server::SocketResponse;

pub async fn handle_manage_window<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let payload: WindowManagerRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for manageWindow: {}", e)))?;

    // Call the async method
    let result = app.tauri_mcp().manage_window_async(payload).await;
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
