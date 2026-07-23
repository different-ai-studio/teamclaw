use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::get_emit_target;
use crate::tools::webview::{emit_and_wait, parse_js_response};

fn default_window_label() -> String {
    "main".to_string()
}

fn default_selector_type() -> String {
    "css".to_string()
}

fn default_steps() -> u32 {
    8
}

#[derive(Debug, Deserialize)]
struct DispatchPointerPayload {
    #[serde(default = "default_window_label")]
    window_label: String,
    #[serde(default = "default_selector_type")]
    selector_type: String,
    selector_value: String,
    gesture: String,
    #[serde(default)]
    offset: Option<Value>,
    #[serde(default)]
    to: Option<Value>,
    #[serde(default = "default_steps")]
    steps: u32,
    #[serde(default)]
    button: u8,
    #[serde(default)]
    modifiers: Option<Vec<String>>,
}

pub async fn handle_dispatch_pointer<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let parsed = serde_json::from_value::<DispatchPointerPayload>(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for dispatch_pointer: {}", e))
    })?;

    let emit_target = get_emit_target(app, &parsed.window_label);

    let js_payload = serde_json::json!({
        "selectorType": parsed.selector_type,
        "selectorValue": parsed.selector_value,
        "gesture": parsed.gesture,
        "offset": parsed.offset,
        "to": parsed.to,
        "steps": parsed.steps,
        "button": parsed.button,
        "modifiers": parsed.modifiers,
    });

    match emit_and_wait(
        app,
        &emit_target,
        "dispatch-pointer",
        "dispatch-pointer-response",
        js_payload,
        std::time::Duration::from_secs(15),
    )
    .await
    {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse::err(
            None,
            format!("Timeout waiting for dispatch_pointer result: {}", e),
        )),
    }
}
