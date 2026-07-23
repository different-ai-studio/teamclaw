use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::get_emit_target;
use crate::tools::webview::{emit_and_wait, parse_js_response};

fn default_window_label() -> String {
    "main".to_string()
}

fn default_all() -> bool {
    true
}

fn default_limit() -> u32 {
    20
}

fn default_max_chars() -> u32 {
    4000
}

#[derive(Debug, Deserialize)]
struct ReadTextPayload {
    #[serde(default = "default_window_label")]
    window_label: String,
    selector: String,
    #[serde(default = "default_all")]
    all: bool,
    #[serde(default = "default_limit")]
    limit: u32,
    #[serde(default)]
    attrs: Option<Vec<String>>,
    #[serde(default = "default_max_chars")]
    max_chars: u32,
    #[serde(default)]
    scope_selector: Option<String>,
}

pub async fn handle_read_text<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let parsed = serde_json::from_value::<ReadTextPayload>(payload)
        .map_err(|e| crate::error::Error::Anyhow(format!("Invalid payload for read_text: {}", e)))?;

    let emit_target = get_emit_target(app, &parsed.window_label);

    let js_payload = serde_json::json!({
        "selector": parsed.selector,
        "all": parsed.all,
        "limit": parsed.limit,
        "attrs": parsed.attrs,
        "maxChars": parsed.max_chars,
        "scopeSelector": parsed.scope_selector,
    });

    match emit_and_wait(
        app,
        &emit_target,
        "read-text",
        "read-text-response",
        js_payload,
        std::time::Duration::from_secs(10),
    )
    .await
    {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(
            None,
            format!("Timeout waiting for read_text result: {}", e),
        )),
    }
}
