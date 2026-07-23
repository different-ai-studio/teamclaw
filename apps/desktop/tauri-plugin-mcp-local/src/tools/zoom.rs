use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Runtime};

use crate::desktop::{get_emit_target, get_webview_for_eval};
use crate::socket_server::SocketResponse;
use crate::tools::webview::{emit_and_wait, parse_js_response};

/// Last zoom scale set through this tool, per window label. The webview
/// API has no zoom getter — devicePixelRatio only reflects zoom indirectly
/// (baseline DPR × zoom), so we remember what we set to report it back.
fn zoom_factors() -> &'static Mutex<HashMap<String, f64>> {
    static ZOOM: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();
    ZOOM.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Deserialize)]
struct ZoomPayload {
    window_label: Option<String>,
    action: String,
    scale: Option<f64>,
}

/// Handler for manage_zoom — get/set webview zoom level
pub async fn handle_manage_zoom<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let parsed: ZoomPayload = serde_json::from_value(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for manage_zoom: {}", e))
    })?;

    let window_label = parsed.window_label.unwrap_or_else(|| "main".to_string());
    let webview = get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    match parsed.action.as_str() {
        "set" => {
            let scale = parsed.scale.ok_or_else(|| {
                crate::error::Error::Anyhow("'scale' is required for set action".to_string())
            })?;
            webview.set_zoom(scale).map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to set zoom: {}", e))
            })?;
            if let Ok(mut m) = zoom_factors().lock() {
                m.insert(window_label.clone(), scale);
            }
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"action": "set", "scale": scale}))))
        }
        "get" => {
            let emit_target = get_emit_target(app, &window_label);

            match emit_and_wait(
                app,
                &emit_target,
                "manage-zoom",
                "manage-zoom-response",
                serde_json::json!({"action": "get"}),
                std::time::Duration::from_secs(5),
            ).await {
                Ok(result) => {
                    let mut response = parse_js_response(&result);
                    // Enrich with the zoom factor last set through this tool
                    // (webviews expose no zoom getter; devicePixelRatio alone
                    // forces the caller to know the baseline DPR).
                    if response.success {
                        let factor = zoom_factors()
                            .lock()
                            .ok()
                            .and_then(|m| m.get(&window_label).copied());
                        if let Some(data) = response.data.as_mut().and_then(|d| d.as_object_mut()) {
                            match factor {
                                Some(f) => data.insert("zoomFactor".into(), serde_json::json!(f)),
                                None => data.insert(
                                    "zoomFactor".into(),
                                    serde_json::json!("unknown (not set via this tool; default 1.0 unless the app changed it)"),
                                ),
                            };
                        }
                    }
                    Ok(response)
                }
                Err(e) => Ok(SocketResponse::err(None, format!("Timeout waiting for zoom level: {}", e))),
            }
        }
        _ => Ok(SocketResponse::err(None, format!(
                "Unknown action '{}'. Valid actions: set, get",
                parsed.action
            ))),
    }
}
