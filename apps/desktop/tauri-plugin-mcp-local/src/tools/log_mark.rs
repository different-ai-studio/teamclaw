use log::info;
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::error::Error;
use crate::log_buffer;
use crate::socket_server::SocketResponse;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogMarkRequest {
    /// Tag/id for the marker. The agent should reuse the same tag for the
    /// matching BEGIN/END pair and then pass it as `between` to query_logs.
    id: String,
    /// Optional free-form note attached to the marker message.
    #[serde(default)]
    note: Option<String>,
}

pub async fn handle_log_mark<R: Runtime>(
    _app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let req: LogMarkRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for log_mark: {}", e)))?;

    if req.id.trim().is_empty() {
        return Err(Error::Anyhow("log_mark: 'id' must not be empty".into()));
    }

    let entry_id = log_buffer::global().mark(&req.id, req.note.as_deref());
    let marker_count = log_buffer::global().marker_count(&req.id);
    info!("[TAURI_MCP] log_mark id={} entry_id={}", req.id, entry_id);

    Ok(SocketResponse::ok(None, Some(serde_json::json!({
            "id": req.id,
            "entryId": entry_id,
            "markerCount": marker_count,
        }))))
}
