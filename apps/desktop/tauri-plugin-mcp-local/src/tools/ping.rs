use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::TauriMcpExt;
use crate::error::Error;
use crate::models::PingRequest;
use crate::socket_server::SocketResponse;

pub fn handle_ping<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let payload: PingRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for ping: {}", e)))?;

    match app.tauri_mcp().ping(payload) {
        Ok(response) => {
            let data = serde_json::to_value(response)
                .map_err(|e| Error::Anyhow(format!("Failed to serialize response: {}", e)))?;
            Ok(SocketResponse::ok(None, Some(data)))
        }
        Err(e) => Ok(SocketResponse::err(None, e.to_string())),
    }
}
