use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::get_emit_target;
use crate::tools::webview::{emit_and_wait, parse_js_response};

fn default_window_label() -> String {
    "main".to_string()
}

fn default_limit() -> u32 {
    10
}

#[derive(Debug, Deserialize)]
struct InspectElementPayload {
    #[serde(default = "default_window_label")]
    window_label: String,
    selector: String,
    #[serde(default)]
    all: bool,
    #[serde(default = "default_limit")]
    limit: u32,
    #[serde(default)]
    style_props: Option<Vec<String>>,
}

pub async fn handle_inspect_element<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let parsed = serde_json::from_value::<InspectElementPayload>(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for inspect_element: {}", e))
    })?;

    let emit_target = get_emit_target(app, &parsed.window_label);

    let js_payload = serde_json::json!({
        "selector": parsed.selector,
        "all": parsed.all,
        "limit": parsed.limit,
        "styleProps": parsed.style_props,
    });

    match emit_and_wait(
        app,
        &emit_target,
        "inspect-element",
        "inspect-element-response",
        js_payload,
        std::time::Duration::from_secs(10),
    )
    .await
    {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(
            None,
            format!("Timeout waiting for inspect_element result: {}", e),
        )),
    }
}
