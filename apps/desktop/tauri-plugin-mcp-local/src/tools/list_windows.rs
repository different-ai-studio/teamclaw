use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::socket_server::SocketResponse;

/// Handler for list_windows — enumerate all windows/webviews with metadata
pub async fn handle_list_windows<R: Runtime>(
    app: &AppHandle<R>,
    _payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let mut windows = Vec::new();

    for (label, ww) in app.webview_windows() {
        let url = ww.url().map(|u| u.to_string()).unwrap_or_default();
        let title = ww.title().unwrap_or_default();
        let is_visible = ww.is_visible().unwrap_or(false);
        let is_focused = ww.is_focused().unwrap_or(false);
        let is_maximized = ww.is_maximized().unwrap_or(false);
        let is_fullscreen = ww.is_fullscreen().unwrap_or(false);
        let scale_factor = ww.scale_factor().unwrap_or(1.0);
        let outer_size = ww.outer_size().ok();
        let inner_size = ww.inner_size().ok();
        let outer_position = ww.outer_position().ok();

        // Try to determine which monitor this window is on
        let current_monitor = ww.current_monitor().ok().flatten().map(|m| {
            serde_json::json!({
                "name": m.name().map(|n| n.to_string()),
            })
        });

        windows.push(serde_json::json!({
            "label": label,
            "title": title,
            "url": url,
            "visible": is_visible,
            "focused": is_focused,
            "maximized": is_maximized,
            "fullscreen": is_fullscreen,
            "scaleFactor": scale_factor,
            "outerSize": outer_size.map(|s| serde_json::json!({"width": s.width, "height": s.height})),
            "innerSize": inner_size.map(|s| serde_json::json!({"width": s.width, "height": s.height})),
            "position": outer_position.map(|p| serde_json::json!({"x": p.x, "y": p.y})),
            "monitor": current_monitor,
        }));
    }

    Ok(SocketResponse::ok(None, Some(serde_json::json!({ "windows": windows }))))
}
