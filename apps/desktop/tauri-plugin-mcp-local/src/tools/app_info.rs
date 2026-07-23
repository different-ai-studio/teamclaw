use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::socket_server::SocketResponse;

/// Handler for get_app_info — consolidated environment data
pub async fn handle_get_app_info<R: Runtime>(
    app: &AppHandle<R>,
    _payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let package = app.package_info();

    // Collect window info
    let mut windows = Vec::new();
    for (label, ww) in app.webview_windows() {
        let url = ww.url().map(|u| u.to_string()).unwrap_or_default();
        let size = ww.outer_size().ok();
        let position = ww.outer_position().ok();
        let is_visible = ww.is_visible().unwrap_or(false);
        let is_focused = ww.is_focused().unwrap_or(false);
        let is_maximized = ww.is_maximized().unwrap_or(false);
        let is_fullscreen = ww.is_fullscreen().unwrap_or(false);
        let scale_factor = ww.scale_factor().unwrap_or(1.0);
        let title = ww.title().unwrap_or_default();

        windows.push(serde_json::json!({
            "label": label,
            "title": title,
            "url": url,
            "visible": is_visible,
            "focused": is_focused,
            "maximized": is_maximized,
            "fullscreen": is_fullscreen,
            "scaleFactor": scale_factor,
            "size": size.map(|s| serde_json::json!({"width": s.width, "height": s.height})),
            "position": position.map(|p| serde_json::json!({"x": p.x, "y": p.y})),
        }));
    }

    // Collect monitor info
    let mut monitors = Vec::new();
    if let Ok(available) = app.available_monitors() {
        for monitor in available {
            let name = monitor.name().map(|n| n.to_string());
            let size = monitor.size();
            let position = monitor.position();
            let scale_factor = monitor.scale_factor();
            monitors.push(serde_json::json!({
                "name": name,
                "size": {"width": size.width, "height": size.height},
                "position": {"x": position.x, "y": position.y},
                "scaleFactor": scale_factor,
            }));
        }
    }

    let primary_monitor = app.primary_monitor().ok().flatten().map(|m| {
        serde_json::json!({
            "name": m.name().map(|n| n.to_string()),
            "size": {"width": m.size().width, "height": m.size().height},
            "position": {"x": m.position().x, "y": m.position().y},
            "scaleFactor": m.scale_factor(),
        })
    });

    let data = serde_json::json!({
        "app": {
            "name": package.name,
            "version": package.version.to_string(),
        },
        "os": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
        },
        "windows": windows,
        "monitors": monitors,
        "primaryMonitor": primary_monitor,
    });

    Ok(SocketResponse::ok(None, Some(data)))
}
