use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::{get_emit_target, get_webview_for_eval};
use crate::socket_server::SocketResponse;
use crate::tools::webview::{emit_and_wait, parse_js_response};

#[derive(Debug, Deserialize)]
struct NavigatePayload {
    window_label: Option<String>,
    action: String,
    url: Option<String>,
}

/// Handler for navigate_webview — URL navigation, reload, back/forward
pub async fn handle_navigate_webview<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let parsed: NavigatePayload = serde_json::from_value(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for navigate_webview: {}", e))
    })?;

    let window_label = parsed.window_label.unwrap_or_else(|| "main".to_string());
    let webview = get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    match parsed.action.as_str() {
        "navigate" => {
            let url = parsed.url.ok_or_else(|| {
                crate::error::Error::Anyhow("'url' is required for navigate action".to_string())
            })?;
            let parsed_url: tauri::Url = url.parse().map_err(|e| {
                crate::error::Error::Anyhow(format!("Invalid URL '{}': {}", url, e))
            })?;
            webview.navigate(parsed_url).map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to navigate: {}", e))
            })?;
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"action": "navigate", "url": url}))))
        }
        "reload" => {
            webview.eval("location.reload()").map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to reload: {}", e))
            })?;
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"action": "reload"}))))
        }
        "get_url" => {
            let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
            Ok(SocketResponse::ok(None, Some(serde_json::json!({"url": url}))))
        }
        "back" | "forward" => {
            let emit_target = get_emit_target(app, &window_label);

            let js_payload = serde_json::json!({
                "action": parsed.action,
            });

            match emit_and_wait(
                app,
                &emit_target,
                "navigate-webview",
                "navigate-webview-response",
                js_payload,
                std::time::Duration::from_secs(5),
            ).await {
                Ok(result) => Ok(parse_js_response(&result)),
                Err(e) => Ok(SocketResponse::err(None, format!("Timeout waiting for navigation: {}", e))),
            }
        }
        _ => Ok(SocketResponse::err(None, format!(
                "Unknown action '{}'. Valid actions: navigate, reload, get_url, back, forward",
                parsed.action
            ))),
    }
}
