use serde_json::Value;
use tauri::{AppHandle, Runtime};
use log::info;

use crate::shared::commands;
use crate::socket_server::SocketResponse;

// Export command modules
pub mod console_logs;
pub mod devtools_bridge;
pub mod error_tracker;
pub mod execute_js;
pub mod health_check;
pub mod hot_reload;
pub mod local_storage;
pub mod mouse_movement;
pub mod network_inspector;
pub mod performance;
pub mod ping;
pub mod state_dump;
pub mod storage_inspector;
pub mod take_screenshot;
pub mod text_input;
pub mod webview;
pub mod window_manager;

// Re-export command handler functions
pub use console_logs::{handle_get_console_logs, handle_inject_console_capture};
pub use devtools_bridge::handle_devtools_bridge;
pub use error_tracker::{handle_get_exceptions, handle_inject_error_tracker, handle_clear_exceptions};
pub use execute_js::handle_execute_js;
pub use health_check::handle_health_check;
pub use hot_reload::handle_hot_reload;
pub use local_storage::handle_get_local_storage;
pub use mouse_movement::handle_simulate_mouse_movement;
pub use network_inspector::{handle_network_inspector, handle_inject_network_capture};
pub use performance::handle_get_performance_metrics;
pub use ping::handle_ping;
pub use state_dump::handle_state_dump;
pub use storage_inspector::handle_get_storage_inspector;
pub use take_screenshot::handle_take_screenshot;
pub use text_input::handle_simulate_text_input;
pub use webview::{handle_get_dom, handle_get_element_position, handle_send_text_to_element};
pub use window_manager::handle_manage_window;

/// Handle command routing for socket requests
pub async fn handle_command<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    payload: Value,
) -> crate::Result<SocketResponse> {
    // Log the full request payload
    info!(
        "[TAURI_MCP] Received command: {} with payload: {}",
        command,
        serde_json::to_string_pretty(&payload)
            .unwrap_or_else(|_| "[failed to serialize]".to_string())
    );

    let result = match command {
        commands::PING => handle_ping(app, payload),
        commands::TAKE_SCREENSHOT => handle_take_screenshot(app, payload).await,
        commands::GET_DOM => handle_get_dom(app, payload).await,
        commands::MANAGE_LOCAL_STORAGE => handle_get_local_storage(app, payload).await,
        commands::EXECUTE_JS => handle_execute_js(app, payload).await,
        commands::MANAGE_WINDOW => handle_manage_window(app, payload).await,
        commands::SIMULATE_TEXT_INPUT => handle_simulate_text_input(app, payload).await,
        commands::SIMULATE_MOUSE_MOVEMENT => handle_simulate_mouse_movement(app, payload).await,
        commands::GET_ELEMENT_POSITION => handle_get_element_position(app, payload).await,
        commands::SEND_TEXT_TO_ELEMENT => handle_send_text_to_element(app, payload).await,
        commands::HOT_RELOAD => handle_hot_reload(app, payload).await,
        commands::GET_CONSOLE_LOGS => handle_get_console_logs(app, payload).await,
        commands::INJECT_CONSOLE_CAPTURE => handle_inject_console_capture(app, payload).await,
        commands::NETWORK_INSPECTOR => handle_network_inspector(app, payload).await,
        commands::INJECT_NETWORK_CAPTURE => handle_inject_network_capture(app, payload).await,
        commands::STATE_DUMP => handle_state_dump(app, payload).await,
        commands::DEVTOOLS_BRIDGE => handle_devtools_bridge(app, payload).await,
        commands::GET_EXCEPTIONS => handle_get_exceptions(app, payload).await,
        commands::INJECT_ERROR_TRACKER => handle_inject_error_tracker(app, payload).await,
        commands::CLEAR_EXCEPTIONS => handle_clear_exceptions(app, payload).await,
        commands::GET_PERFORMANCE_METRICS => handle_get_performance_metrics(app, payload).await,
        commands::STORAGE_INSPECTOR => handle_get_storage_inspector(app, payload).await,
        commands::HEALTH_CHECK => handle_health_check(app, payload),
        _ => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Unknown command: {}", command)),
        }),
    };

    // Log the response before returning it
    if let Ok(ref response) = result {
        let success_str = if response.success {
            "SUCCESS"
        } else {
            "FAILURE"
        };
        info!(
            "[TAURI_MCP] Command {} completed with status: {}",
            command, success_str
        );

        if let Some(ref data) = response.data {
            // Only print a preview of the data for large responses
            let data_str =
                serde_json::to_string(data).unwrap_or_else(|_| "[failed to serialize]".to_string());
            if data_str.len() > 1000 {
                info!(
                    "[TAURI_MCP] Response data preview (first 1000 chars): {}",
                    &data_str[..1000.min(data_str.len())]
                );
                info!(
                    "[TAURI_MCP] ... (response data truncated, total length: {} bytes)",
                    data_str.len()
                );
            } else {
                info!("[TAURI_MCP] Response data: {}", data_str);
            }
        }

        if let Some(ref err) = response.error {
            info!("[TAURI_MCP] Error: {}", err);
        }
    } else if let Err(ref e) = result {
        info!(
            "[TAURI_MCP] Command {} failed with error: {}",
            command, e
        );
    }

    result
}
