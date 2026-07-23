use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::get_webview_for_eval;
use crate::socket_server::SocketResponse;

#[derive(Debug, Deserialize)]
struct WebviewStatePayload {
    window_label: Option<String>,
    action: String,
    r: Option<u8>,
    g: Option<u8>,
    b: Option<u8>,
    a: Option<u8>,
    enabled: Option<bool>,
}

/// Handler for manage_webview_state — clear data, set background, get bounds, auto resize
pub async fn handle_manage_webview_state<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let parsed: WebviewStatePayload = serde_json::from_value(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for manage_webview_state: {}", e))
    })?;

    let window_label = parsed.window_label.unwrap_or_else(|| "main".to_string());
    let webview = get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    match parsed.action.as_str() {
        "clear_browsing_data" => match webview.clear_all_browsing_data() {
            Ok(_) => Ok(SocketResponse::ok(None, Some(serde_json::json!({"cleared": true})))),
            Err(e) => Ok(SocketResponse::err(None, format!("Failed to clear browsing data: {}", e))),
        },
        "set_background_color" => {
            let r = parsed.r.unwrap_or(255);
            let g = parsed.g.unwrap_or(255);
            let b = parsed.b.unwrap_or(255);
            let a = parsed.a.unwrap_or(255);
            webview
                .set_background_color(Some((r, g, b, a).into()))
                .map_err(|e| {
                    crate::error::Error::Anyhow(format!(
                        "Failed to set background color: {}",
                        e
                    ))
                })?;
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"r": r, "g": g, "b": b, "a": a}))))
        }
        "get_bounds" => {
            let position = webview.position().ok();
            let size = webview.size().ok();
            Ok(SocketResponse::ok(None, Some(serde_json::json!({
                    "position": position.map(|p| serde_json::json!({"x": p.x, "y": p.y})),
                    "size": size.map(|s| serde_json::json!({"width": s.width, "height": s.height})),
                }))))
        }
        "set_auto_resize" => {
            let enabled = parsed.enabled.unwrap_or(true);
            webview.set_auto_resize(enabled).map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to set auto resize: {}", e))
            })?;
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"autoResize": enabled}))))
        }
        _ => Ok(SocketResponse::err(None, format!(
                "Unknown action '{}'. Valid actions: clear_browsing_data, set_background_color, get_bounds, set_auto_resize",
                parsed.action
            ))),
    }
}
