//! Multi-window support — Phase 2 MVP.
//!
//! Each secondary workspace window owns its own OpenCode sidecar instance on
//! a dynamically-allocated port. The window registry maps window labels to
//! workspace paths so the Destroyed handler can shut the matching sidecar.

use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::opencode::{find_available_port, shutdown_opencode, OpenCodeState};

/// window_label → workspace_path mapping for every workspace-owning window.
///
/// Both the main window (label `"main"`) and secondary windows opened via
/// `create_workspace_window` register here. Commands resolve their workspace
/// from the calling window's label so that, in multi-window mode, an event
/// from window A never routes to window B's sidecar.
#[derive(Default)]
pub struct WindowRegistry {
    pub windows: Mutex<HashMap<String, String>>,
}

/// Insert or update the label → workspace mapping. Called from `start_opencode`
/// for the main window and from `create_workspace_window` for secondary windows.
pub fn register_window_workspace(registry: &WindowRegistry, label: &str, workspace_path: &str) {
    if let Ok(mut windows) = registry.windows.lock() {
        windows.insert(label.to_string(), workspace_path.to_string());
    }
}

/// Look up the workspace path associated with a window label.
pub fn workspace_for_window(registry: &WindowRegistry, label: &str) -> Option<String> {
    registry.windows.lock().ok()?.get(label).cloned()
}

/// Resolve the workspace for the calling window.
///
/// Strategy:
/// 1. Look up the window label in `WindowRegistry` — this is authoritative once
///    `start_opencode` has run.
/// 2. Fall back to single-instance inference via `current_workspace_path`. This
///    keeps single-window flows working before the registry is populated and
///    preserves existing behavior for any caller that doesn't own a sidecar.
///
/// In multi-window mode the registry lookup almost always succeeds; the
/// fallback only fires during the brief window before the calling window's
/// `start_opencode` has registered itself, in which case `current_workspace_path`
/// errors with the existing "N instances active" message rather than silently
/// routing to the wrong workspace.
pub fn current_workspace_for_window(
    window: &tauri::WebviewWindow,
    registry: &WindowRegistry,
    state: &OpenCodeState,
) -> Result<String, String> {
    if let Some(ws) = workspace_for_window(registry, window.label()) {
        return Ok(ws);
    }
    super::opencode::current_workspace_path(state)
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

    let ws_name = std::path::Path::new(&workspace_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("TeamClaw");
    let window_title = format!("TeamClaw — {}", ws_name);

    // Match the main window chrome: hidden title + overlay traffic lights on macOS,
    // so the workspace name shown inside the app remains the only label.
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(&window_title)
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

    // hidden_title(true) on macOS hides the title bar text but the OS still reads
    // NSWindow.title for the dock right-click menu — set it explicitly post-build.
    let _ = win.set_title(&window_title);

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

/// Update the title of the calling window (used by the frontend after workspace selection).
/// This keeps the dock right-click menu label in sync with the active workspace.
#[tauri::command]
pub fn set_window_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}
