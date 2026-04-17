//! Multi-window support — Phase 2 MVP.
//!
//! Each secondary workspace window owns its own OpenCode sidecar instance on
//! a dynamically-allocated port. The window registry maps window labels to
//! workspace paths so the Destroyed handler can shut the matching sidecar.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

use super::opencode::{find_available_port, shutdown_opencode, OpenCodeState};

/// window_label → workspace_path mapping for active secondary workspace windows.
#[derive(Default)]
pub struct WindowRegistry {
    pub windows: Mutex<HashMap<String, String>>,
}

/// Look up the workspace path associated with a window label.
/// Phase 2 commands routing per-window will read this; today's commands still
/// rely on the single-instance fallback in `resolve_workspace`.
#[allow(dead_code)]
pub fn workspace_for_window(registry: &WindowRegistry, label: &str) -> Option<String> {
    registry.windows.lock().ok()?.get(label).cloned()
}

/// Open a new TeamClaw window for an additional workspace.
///
/// Allocates a fresh sidecar port, generates a unique window label, registers
/// the label→workspace mapping, and opens the window with `?workspace=&port=`
/// query params. The frontend reads these in `useAppInit` and starts the
/// sidecar on the assigned port.
#[tauri::command]
pub async fn create_workspace_window(
    app: AppHandle,
    registry: tauri::State<'_, WindowRegistry>,
    workspace_path: String,
) -> Result<String, String> {
    if workspace_path.trim().is_empty() {
        return Err("workspace_path is empty".to_string());
    }

    // Allocate a port for this window's sidecar. Phase 1 main slot uses
    // DEFAULT_PORT; secondary windows always get a free ephemeral port.
    let port = find_available_port().await?;

    // Unique label so multiple secondary windows can coexist.
    let label = format!("ws-{}", nanoid::nanoid!(10));

    {
        let mut windows = registry.windows.lock().map_err(|e| e.to_string())?;
        windows.insert(label.clone(), workspace_path.clone());
    }

    let encoded_ws = urlencoding::encode(&workspace_path);
    let url = format!("index.html?workspace={}&port={}", encoded_ws, port);

    // Match the main window chrome: hidden title + overlay traffic lights on macOS,
    // so the workspace name shown inside the app remains the only label.
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("TeamClaw")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .decorations(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    let win = builder.build().map_err(|e| {
        // Rollback registration if window creation failed.
        if let Ok(mut windows) = registry.windows.lock() {
            windows.remove(&label);
        }
        format!("Failed to create window: {}", e)
    })?;

    // Reposition the macOS traffic lights to match the main window's offset.
    #[cfg(target_os = "macos")]
    super::spotlight::reposition_traffic_lights(&win);

    // Cleanup on close: unregister + shutdown the sidecar for this workspace.
    let app_handle = app.clone();
    let label_for_handler = label.clone();
    let workspace_for_handler = workspace_path.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let app = app_handle.clone();
            let label = label_for_handler.clone();
            let ws = workspace_for_handler.clone();
            tauri::async_runtime::spawn(async move {
                println!("[Window] Destroyed: {} (workspace: {})", label, ws);
                if let Some(registry) = app.try_state::<WindowRegistry>() {
                    if let Ok(mut windows) = registry.windows.lock() {
                        windows.remove(&label);
                    }
                }
                if let Some(state) = app.try_state::<OpenCodeState>() {
                    if let Err(e) = shutdown_opencode(&state, Some(&ws)).await {
                        eprintln!("[Window] Failed to shut sidecar for {}: {}", ws, e);
                    }
                }
            });
        }
    });

    Ok(label)
}
