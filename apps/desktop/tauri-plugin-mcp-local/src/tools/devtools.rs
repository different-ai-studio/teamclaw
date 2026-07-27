use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::socket_server::SocketResponse;

#[derive(Debug, Deserialize)]
struct DevtoolsPayload {
    window_label: Option<String>,
    action: String,
}

/// Handler for manage_devtools — open/close/check devtools
pub async fn handle_manage_devtools<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let parsed: DevtoolsPayload = serde_json::from_value(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for manage_devtools: {}", e))
    })?;

    let window_label = parsed.window_label.unwrap_or_else(|| "main".to_string());
    let ww = app.get_webview_window(&window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Window not found: {}", window_label))
    })?;

    match parsed.action.as_str() {
        "open" => {
            ww.open_devtools();
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"action": "open", "devtools": true}))))
        }
        "close" => {
            ww.close_devtools();
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"action": "close", "devtools": false}))))
        }
        "is_open" => {
            let is_open = ww.is_devtools_open();
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"isOpen": is_open}))))
        }
        _ => Ok(SocketResponse::err(None, format!(
                "Unknown action '{}'. Valid actions: open, close, is_open",
                parsed.action
            ))),
    }
}
