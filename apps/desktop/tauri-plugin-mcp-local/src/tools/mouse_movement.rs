use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::Error;
use crate::models::MouseMovementRequest;
use crate::native_input::{self, MouseButton, MouseParams};
use crate::native_input::state::VirtualCursorState;
use crate::socket_server::SocketResponse;
use std::time::Instant;
use log::info;

pub async fn simulate_mouse_movement_async<R: Runtime>(
    app: &AppHandle<R>,
    params: MouseMovementRequest,
) -> crate::Result<crate::models::MouseMovementResponse> {
    info!(
        "[MOUSE_MOVEMENT] Starting mouse movement with params: {:?}",
        params
    );

    let window_label = params.window_label.as_deref().unwrap_or("main");

    // Resolve webview for native event injection
    let webview = crate::desktop::get_webview_for_eval(app, window_label)
        .ok_or_else(|| Error::Anyhow(format!("Webview not found: {}", window_label)))?;

    // Get virtual cursor state
    let cursor_state = app.state::<VirtualCursorState>();

    let x = params.x;
    let y = params.y;
    let relative = params.relative.unwrap_or(false);
    let click = params.click.unwrap_or(false);
    let button = MouseButton::from_str_opt(params.button.as_deref());

    // Calculate target coordinates
    let (target_x, target_y) = if relative {
        let (cur_x, cur_y) = cursor_state.get();
        (cur_x + x, cur_y + y)
    } else {
        (x, y)
    };

    info!(
        "[MOUSE_MOVEMENT] Target coordinates: ({}, {}), click={}, button={:?}",
        target_x, target_y, click, button
    );

    let start_time = Instant::now();

    let mouse_params = MouseParams {
        x: target_x,
        y: target_y,
        click,
        button,
        mouse_down: params.mouse_down.unwrap_or(false),
        mouse_up: params.mouse_up.unwrap_or(false),
    };

    let result = native_input::backend::inject_mouse(&webview, &mouse_params)
        .map_err(|e| Error::Anyhow(format!("Native mouse injection failed: {}", e)))?;

    // Update virtual cursor state
    cursor_state.set(result.position.0, result.position.1);

    // After a click, inject JS to focus the nearest typeable element at click coords.
    // This ensures the guest-js _lastFocusedElement tracker picks up the focus change,
    // so subsequent type_text calls in focused mode (no selector) find the right element.
    if click {
        let focus_js = format!(
            r#"(function(){{
                var el = document.elementFromPoint({x},{y});
                if(!el) return;
                window.__mcpLastClickCoords={{x:{x},y:{y}}};
                var t=el;
                while(t&&t!==document.body){{
                    var tag=t.tagName;
                    if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') break;
                    if(t.isContentEditable) break;
                    if(t.hasAttribute&&(t.hasAttribute('data-lexical-editor')||t.hasAttribute('data-slate-editor'))) break;
                    if(t.closest&&(t.closest('[data-lexical-editor]')||t.closest('[data-slate-editor]'))) break;
                    t=t.parentElement;
                }}
                if(t&&t!==document.body&&t.focus){{t.focus({{preventScroll:true}});}}
            }})()"#,
            x = target_x, y = target_y
        );
        let _ = webview.eval(&focus_js);
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;

    info!(
        "[MOUSE_MOVEMENT] Completed in {}ms, position=({}, {})",
        duration_ms, result.position.0, result.position.1
    );

    Ok(crate::models::MouseMovementResponse {
        success: true,
        duration_ms,
        position: Some(result.position),
    })
}

pub async fn handle_simulate_mouse_movement<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    // Parse the payload
    let params: MouseMovementRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for simulateMouseMovement: {}", e)))?;

    // Call the async method
    let result = simulate_mouse_movement_async(app, params).await;

    match result {
        Ok(response) => {
            let data = serde_json::to_value(response)
                .map_err(|e| Error::Anyhow(format!("Failed to serialize response: {}", e)))?;
            Ok(SocketResponse::ok(None, Some(data)))
        }
        Err(e) => Ok(SocketResponse::err(None, e.to_string())),
    }
}
