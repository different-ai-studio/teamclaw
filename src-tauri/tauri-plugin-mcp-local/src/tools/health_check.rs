use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use log::info;

use crate::error::Error;
use crate::socket_server::SocketResponse;
use std::env;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckResponse {
    pub status: String,
    pub plugin_version: String,
    pub build_info: BuildInfo,
    pub system_info: SystemInfo,
    pub capabilities: Vec<String>,
    pub connection_status: ConnectionStatus,
    pub webview_status: WebviewStatus,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: String,
    pub rust_version: String,
    pub profile: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub platform: String,
    pub arch: String,
    pub cpu_count: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub socket_server_running: bool,
    pub event_system_available: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewStatus {
    pub webview_available: bool,
    pub main_window_available: bool,
}

pub fn handle_health_check<R: Runtime>(
    app: &AppHandle<R>,
    _payload: Value,
) -> Result<SocketResponse, Error> {
    info!("[TAURI_MCP] Health check requested");

    let capabilities = detect_capabilities(app);
    let webview_status = check_webview_status(app);
    let connection_status = ConnectionStatus {
        socket_server_running: true,
        event_system_available: true,
    };

    let response = HealthCheckResponse {
        status: "healthy".to_string(),
        plugin_version: env!("CARGO_PKG_VERSION").to_string(),
        build_info: BuildInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            rust_version: env!("CARGO_PKG_RUST_VERSION").to_string(),
            profile: get_profile().to_string(),
        },
        system_info: SystemInfo {
            os: get_os().to_string(),
            platform: get_platform().to_string(),
            arch: env::consts::ARCH.to_string(),
            cpu_count: get_cpu_count(),
        },
        capabilities,
        connection_status,
        webview_status,
    };

    let data = serde_json::to_value(&response)
        .map_err(|e| Error::serialization_error(format!("Failed to serialize response: {}", e)))?;

    Ok(SocketResponse {
        success: true,
        data: Some(data),
        error: None,
    })
}

fn detect_capabilities<R: Runtime>(_app: &AppHandle<R>) -> Vec<String> {
    vec![
        "take_screenshot".to_string(),
        "get_dom".to_string(),
        "execute_js".to_string(),
        "manage_window".to_string(),
        "simulate_text_input".to_string(),
        "simulate_mouse_movement".to_string(),
        "get_element_position".to_string(),
        "send_text_to_element".to_string(),
        "manage_local_storage".to_string(),
        "hot_reload".to_string(),
        "get_console_logs".to_string(),
        "inject_console_capture".to_string(),
        "network_inspector".to_string(),
        "inject_network_capture".to_string(),
        "state_dump".to_string(),
        "get_exceptions".to_string(),
        "inject_error_tracker".to_string(),
        "clear_exceptions".to_string(),
        "get_performance_metrics".to_string(),
        "health_check".to_string(),
    ]
}

fn check_webview_status<R: Runtime>(app: &AppHandle<R>) -> WebviewStatus {
    let main_window_available = app.get_webview_window("main").is_some();

    WebviewStatus {
        webview_available: true,
        main_window_available,
    }
}

fn get_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        "Unknown"
    }
}

fn get_platform() -> &'static str {
    if cfg!(target_family = "unix") {
        "Unix"
    } else if cfg!(target_family = "windows") {
        "Windows"
    } else {
        "Unknown"
    }
}

fn get_profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

fn get_cpu_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}
