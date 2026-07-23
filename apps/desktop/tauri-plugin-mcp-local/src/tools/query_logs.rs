use log::info;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::error::Error;
use crate::log_buffer::{self, LogQuery};
use crate::socket_server::SocketResponse;

/// Handle the `query_logs` socket command.
///
/// Payload (all fields optional):
///   - `level`: "error" | "warn" | "info" | "debug" | "trace" (threshold; "warn" => warn+error)
///   - `source`: "rust" | "js"
///   - `sinceId`: number — only entries with id > this (pagination cursor)
///   - `sinceMs`: number — only entries newer than this unix-ms timestamp
///   - `contains`: string — case-insensitive substring filter on message
///   - `limit`: number — max entries (default 100, max 1000)
///   - `head`: bool — if true, return oldest matching; else newest (default)
///   - `mode`: "tail" (default) | "summary" — summary returns counts + last 10 warns/errors
pub async fn handle_query_logs<R: Runtime>(
    _app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let mode = payload
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("tail")
        .to_string();

    // Strip `mode` before deserializing the rest as LogQuery.
    let mut filter_payload = payload.clone();
    if let Some(obj) = filter_payload.as_object_mut() {
        obj.remove("mode");
    }

    let query: LogQuery = serde_json::from_value(filter_payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for query_logs: {}", e)))?;

    info!(
        "[TAURI_MCP] query_logs mode={} level={:?} source={:?} contains={:?} limit={:?}",
        mode, query.level, query.source, query.contains, query.limit
    );

    let buffer = log_buffer::global();

    let data = if mode == "summary" {
        // Summary: full counts + last 10 entries at warn or above. Tiny payload.
        let warn_query = LogQuery {
            level: Some("warn".into()),
            limit: Some(10),
            ..Default::default()
        };
        let warn_result = buffer.query(&warn_query);
        let overall = buffer.query(&LogQuery::default());
        serde_json::json!({
            "mode": "summary",
            "bufferSize": overall.buffer_size,
            "bufferCapacity": overall.buffer_capacity,
            "droppedTotal": overall.dropped_total,
            "counts": overall.counts,
            "recentWarningsAndErrors": warn_result.entries,
        })
    } else {
        let result = buffer.query(&query);
        serde_json::to_value(result)
            .map_err(|e| Error::Anyhow(format!("Failed to serialize result: {}", e)))?
    };

    Ok(SocketResponse::ok(None, Some(data)))
}
