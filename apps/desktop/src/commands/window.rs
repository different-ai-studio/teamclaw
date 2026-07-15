//! Multi-window support — Phase 2 MVP.
//!
//! The window registry maps window labels to workspace paths so that
//! commands can resolve the correct workspace for the calling window.

use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// window_label → workspace_path mapping for every workspace-owning window.
///
/// Both the main window (label `"main"`) and secondary windows opened via
/// `create_workspace_window` register here. Commands resolve their workspace
/// from the calling window's label so that, in multi-window mode, an event
/// from window A never routes to window B's workspace.
#[derive(Default)]
pub struct WindowRegistry {
    pub windows: Mutex<HashMap<String, String>>,
    /// Single-window fallback: last registered workspace path.
    pub current_workspace: Mutex<Option<String>>,
}

/// Insert or update the label → workspace mapping.
/// Also updates the single-window fallback.
pub fn bind_window_to_workspace(registry: &WindowRegistry, label: &str, workspace_path: &str) {
    if let Ok(mut windows) = registry.windows.lock() {
        windows.insert(label.to_string(), workspace_path.to_string());
    }
    if let Ok(mut cw) = registry.current_workspace.lock() {
        *cw = Some(workspace_path.to_string());
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
///    the workspace is selected.
/// 2. Fall back to `current_workspace` for the single-window flow before
///    the registry is populated.
pub fn current_workspace_for_window(
    window: &tauri::WebviewWindow,
    registry: &WindowRegistry,
) -> Result<String, String> {
    if let Some(ws) = workspace_for_window(registry, window.label()) {
        return Ok(ws);
    }
    registry
        .current_workspace
        .lock()
        .ok()
        .and_then(|cw| cw.clone())
        .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())
}

/// Open a new TeamClaw window for an additional workspace.
///
/// Generates a unique window label, registers the label→workspace mapping,
/// and opens the window with `?workspace=` query param.
#[tauri::command]
pub async fn create_workspace_window(
    app: AppHandle,
    registry: tauri::State<'_, WindowRegistry>,
    workspace_path: String,
) -> Result<String, String> {
    if workspace_path.trim().is_empty() {
        return Err("workspace_path is empty".to_string());
    }

    // Unique label so multiple secondary windows can coexist.
    let label = format!("ws-{}", nanoid::nanoid!(10));

    {
        let mut windows = registry.windows.lock().map_err(|e| e.to_string())?;
        windows.insert(label.clone(), workspace_path.clone());
    }

    let encoded_ws = urlencoding::encode(&workspace_path);
    let url = format!("index.html?workspace={}", encoded_ws);

    let brand = crate::branding::brand_name(app.config().product_name.as_deref());
    let ws_name = std::path::Path::new(&workspace_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(brand.as_str());
    let window_title = format!("{} — {}", brand, ws_name);

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
    super::window_chrome::reposition_traffic_lights(&win);

    // Cleanup on close: unregister this window's workspace mapping.
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
            });
        }
    });

    Ok(label)
}

/// Bind the calling window to a workspace path.
///
/// Daemon-mode startup no longer goes through `start_opencode`, so the frontend
/// must call this after `setWorkspace` so window-scoped IPC commands can resolve
/// the active workspace (env catalog, MCP, etc.).
#[tauri::command]
pub fn register_window_workspace(
    window: WebviewWindow,
    registry: tauri::State<'_, WindowRegistry>,
    workspace_path: String,
) -> Result<(), String> {
    if workspace_path.trim().is_empty() {
        return Err("workspace_path is empty".to_string());
    }
    bind_window_to_workspace(&registry, window.label(), &workspace_path);
    // Identity == daemon actor_id (empty until the daemon is onboarded; the
    // tc_api_key generator then yields None and no key is seeded).
    let actor_id = super::daemon_http::read_daemon_actor_id();
    if let Err(e) = super::env_vars::ensure_system_env_vars(&workspace_path, &actor_id) {
        eprintln!(
            "[EnvVars] Warning: failed to ensure system env vars on workspace bind: {}",
            e
        );
    }
    Ok(())
}

/// Update the title of the calling window (used by the frontend after workspace selection).
/// This keeps the dock right-click menu label in sync with the active workspace.
#[tauri::command]
pub fn set_window_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}
