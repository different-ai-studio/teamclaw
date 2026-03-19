use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::Error;
use crate::socket_server::SocketResponse;

#[derive(Debug, Deserialize)]
struct HotReloadPayload {
    /// The label of the window to reload. Defaults to "main" if not provided.
    window_label: Option<String>,
}

#[derive(Debug, Serialize)]
struct HotReloadResult {
    success: bool,
    window_label: String,
    message: String,
}

/// Handler function for hot_reload command
/// Reloads the webview without restarting the entire Tauri application
pub async fn handle_hot_reload<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    // Parse the payload
    let payload: HotReloadPayload = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for hot_reload: {}", e)))?;

    let window_label = payload.window_label.unwrap_or_else(|| "main".to_string());

    // Get the window by label
    let window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| Error::window_not_found(&window_label))?;

    // Get the current URL and reload by navigating to it
    // This is the safest cross-platform approach using Tauri's public API
    let current_url = window.url().map_err(|e| {
        Error::window_operation_failed("get window URL", format!("{}", e))
    })?;

    let reload_result = window.navigate(current_url);

    match reload_result {
        Ok(_) => {
            let result = HotReloadResult {
                success: true,
                window_label: window_label.clone(),
                message: format!("Successfully reloaded window: {}", window_label),
            };

            let data = serde_json::to_value(result)
                .map_err(|e| Error::serialization_error(format!("Failed to serialize response: {}", e)))?;

            Ok(SocketResponse {
                success: true,
                data: Some(data),
                error: None,
            })
        }
        Err(e) => {
            let error_msg = format!("Failed to reload window {}: {}", window_label, e);

            Ok(SocketResponse {
                success: false,
                data: None,
                error: Some(error_msg),
            })
        }
    }
}
