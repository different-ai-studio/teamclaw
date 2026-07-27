use serde_json::Value;
use tauri::{AppHandle, Runtime};
use log::info;

use crate::error::Error;
use crate::models::RestartAppRequest;
use crate::socket_server::SocketResponse;

pub async fn handle_restart_app<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: RestartAppRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for restart_app: {}", e)))?;

    // In dev mode, restart() re-execs the binary OUTSIDE the `tauri dev`
    // supervisor: the supervisor sees its child exit, tears down the dev
    // server, and the relaunched process is left orphaned pointing at a dead
    // devUrl. The result is a dead app that briefly looked healthy. Refuse
    // loudly instead of pretending this works.
    if tauri::is_dev() {
        return Ok(SocketResponse::err(
            None,
            "restart_app is not supported in dev mode: tauri::process::restart() re-execs \
             the app outside the `tauri dev` supervisor, which then shuts down the dev \
             server and kills the relaunched app. Ask the user to restart their dev \
             command (e.g. `pnpm tauri dev`) instead. To reload the frontend without a \
             process restart, use navigate(action='reload')."
                .to_string(),
        ));
    }

    // Clamp delay_ms to 100-5000, default 500
    let delay_ms = request.delay_ms.unwrap_or(500).clamp(100, 5000);

    info!("[TAURI_MCP] Scheduling app restart in {}ms", delay_ms);

    let app_handle = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        info!("[TAURI_MCP] Executing app restart now");
        // restart() returns `!` — it terminates the process or blocks forever.
        // This is intentional: the spawned task is fire-and-forget.
        app_handle.restart();
    });

    Ok(SocketResponse::ok(None, Some(serde_json::json!({
            "message": format!("Restarting application in {}ms", delay_ms)
        }))))
}
