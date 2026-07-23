use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::get_emit_target;
use crate::tools::webview::{emit_and_wait, parse_js_response};

fn default_window_label() -> String {
    "main".to_string()
}

fn default_timeout_ms() -> u64 {
    10_000
}

fn default_max_chars() -> u32 {
    20_000
}

#[derive(Debug, Deserialize)]
struct AppBridgePayload {
    #[serde(default = "default_window_label")]
    window_label: String,
    action: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    args: Option<Value>,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: u64,
    #[serde(default = "default_max_chars")]
    max_chars: u32,
}

pub async fn handle_app_bridge<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let parsed = serde_json::from_value::<AppBridgePayload>(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for app_bridge: {}", e))
    })?;

    let emit_target = get_emit_target(app, &parsed.window_label);

    let js_payload = serde_json::json!({
        "action": parsed.action,
        "name": parsed.name,
        "args": parsed.args,
        "timeoutMs": parsed.timeout_ms,
        "maxChars": parsed.max_chars,
    });

    // Give the in-page call its full timeout plus transport slack
    let rust_timeout = std::time::Duration::from_millis(parsed.timeout_ms + 2_000);

    match emit_and_wait(
        app,
        &emit_target,
        "app-bridge",
        "app-bridge-response",
        js_payload,
        rust_timeout,
    )
    .await
    {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(
            None,
            format!("Timeout waiting for app_bridge result: {}", e),
        )),
    }
}
