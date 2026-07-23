use crate::error::Error;
use crate::models::*;
use crate::native_input::{self, TextParams};
use crate::shared::ScreenshotParams;
use crate::socket_server::SocketServer;
use crate::tools::mouse_movement;
use crate::{PluginConfig, Result};
use log::info;
use serde::de::DeserializeOwned;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime, plugin::PluginApi};

// ----- Webview Fallback Config -----

/// Stores the configured fallback webview label, managed as Tauri state.
pub struct WebviewFallbackConfig {
    pub label: Option<String>,
}

// ----- Window/Webview Resolution Helpers -----

/// Represents either a WebviewWindow or a separate Window handle
pub enum WindowHandle<R: Runtime> {
    WebviewWindow(tauri::WebviewWindow<R>),
    Window(tauri::Window<R>),
}

impl<R: Runtime> WindowHandle<R> {
    pub fn minimize(&self) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.minimize(),
            WindowHandle::Window(w) => w.minimize(),
        }
    }

    pub fn maximize(&self) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.maximize(),
            WindowHandle::Window(w) => w.maximize(),
        }
    }

    pub fn unmaximize(&self) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.unmaximize(),
            WindowHandle::Window(w) => w.unmaximize(),
        }
    }

    pub fn close(&self) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.close(),
            WindowHandle::Window(w) => w.close(),
        }
    }

    pub fn show(&self) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.show(),
            WindowHandle::Window(w) => w.show(),
        }
    }

    pub fn hide(&self) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.hide(),
            WindowHandle::Window(w) => w.hide(),
        }
    }

    pub fn set_focus(&self) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.set_focus(),
            WindowHandle::Window(w) => w.set_focus(),
        }
    }

    pub fn set_position(
        &self,
        pos: tauri::LogicalPosition<f64>,
    ) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.set_position(pos),
            WindowHandle::Window(w) => w.set_position(pos),
        }
    }

    pub fn set_size(&self, size: tauri::LogicalSize<f64>) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.set_size(size),
            WindowHandle::Window(w) => w.set_size(size),
        }
    }

    pub fn center(&self) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.center(),
            WindowHandle::Window(w) => w.center(),
        }
    }

    pub fn set_fullscreen(&self, fullscreen: bool) -> std::result::Result<(), tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.set_fullscreen(fullscreen),
            WindowHandle::Window(w) => w.set_fullscreen(fullscreen),
        }
    }

    pub fn is_fullscreen(&self) -> std::result::Result<bool, tauri::Error> {
        match self {
            WindowHandle::WebviewWindow(w) => w.is_fullscreen(),
            WindowHandle::Window(w) => w.is_fullscreen(),
        }
    }
}

/// Get a window handle by label, supporting both WebviewWindow and Window architectures.
/// First tries get_webview_window, then falls back to get_window.
pub fn get_window_handle<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<WindowHandle<R>> {
    // First try WebviewWindow (combined window+webview)
    if let Some(ww) = app.get_webview_window(label) {
        return Some(WindowHandle::WebviewWindow(ww));
    }
    // Fall back to separate Window (multi-webview architecture)
    if let Some(w) = app.get_window(label) {
        return Some(WindowHandle::Window(w));
    }
    None
}

/// Get a webview for JS execution and DOM access.
/// Supports both architectures:
/// - WebviewWindow: returns the webview directly
/// - Multi-webview: falls back to the configured `default_webview_label`
pub fn get_webview_for_eval<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Option<tauri::Webview<R>> {
    // First try WebviewWindow with exact label (returns its inner webview)
    if let Some(ww) = app.get_webview_window(label) {
        return Some(ww.as_ref().clone());
    }
    // Multi-webview architecture: use the configured fallback webview label
    if let Some(config) = app.try_state::<WebviewFallbackConfig>() {
        if let Some(fallback) = &config.label {
            if let Some(wv) = app.get_webview(fallback) {
                return Some(wv);
            }
        }
    }
    // Try direct webview lookup
    app.get_webview(label)
}

/// Get the emit target label for multi-webview architecture.
/// If the window label doesn't match a WebviewWindow, falls back to the
/// configured `default_webview_label` from `PluginConfig`.
pub fn get_emit_target<R: Runtime>(app: &AppHandle<R>, window_label: &str) -> String {
    if app.get_webview_window(window_label).is_none() {
        if let Some(config) = app.try_state::<WebviewFallbackConfig>() {
            if let Some(fallback) = &config.label {
                if app.get_webview(fallback).is_some() {
                    return fallback.to_string();
                }
            }
        }
    }
    window_label.to_string()
}

// ----- Screenshot Utilities -----

/// Helper structure to hold window for screenshot functions.
/// Supports both WebviewWindow and Window architectures.
pub struct ScreenshotContext<R: Runtime> {
    pub window_handle: WindowHandle<R>,
}

/// Create a success response with data
pub fn create_success_response(data_url: String) -> ScreenshotResponse {
    ScreenshotResponse {
        data: Some(data_url),
        success: true,
        error: None,
        file_path: None,
    }
}

/// Create an error response
pub fn create_error_response(error_msg: String) -> ScreenshotResponse {
    ScreenshotResponse {
        data: None,
        success: false,
        error: Some(error_msg),
        file_path: None,
    }
}

// ----- TauriMcp Implementation -----

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
    config: &PluginConfig,
) -> crate::Result<TauriMcp<R>> {
    // Store webview fallback config as managed state for resolution helpers
    app.manage(WebviewFallbackConfig {
        label: config.default_webview_label.clone(),
    });

    // Register virtual cursor state for native input injection
    app.manage(crate::native_input::state::VirtualCursorState::new());

    // Subscribe to `log://log` events emitted by tauri-plugin-log so we can
    // capture Rust-side logs without owning the global `log` logger (which
    // tauri-plugin-log already holds). Cheap and conflict-free: if no
    // tauri-plugin-log is installed the listener simply receives nothing.
    // Skipped when our ring-buffer logger owns the global `log` slot
    // (capture_rust_logs), which would otherwise capture every record twice.
    if !crate::log_buffer::logger_is_active() {
        use tauri::Listener;
        app.listen_any("log://log", |event| {
            #[derive(serde::Deserialize)]
            struct Payload {
                message: String,
                /// Numeric LogLevel from tauri-plugin-log: 1=Trace .. 5=Error.
                level: u16,
            }
            if let Ok(p) = serde_json::from_str::<Payload>(event.payload()) {
                let level = match p.level {
                    1 => "trace",
                    2 => "debug",
                    3 => "info",
                    4 => "warn",
                    5 => "error",
                    _ => "info",
                };
                // tauri-plugin-log prepends "[YYYY-MM-DD][LEVEL][target] " — leave
                // it intact; it gives the LLM useful context (caller module, etc).
                crate::log_buffer::global().push(
                    level,
                    crate::log_buffer::LogSource::Rust,
                    None,
                    p.message,
                );
            }
        });
    }

    let socket_server = if config.start_socket_server {
        let mut server = SocketServer::new(
            app.clone(),
            config.socket_type.clone(),
            config.auth_token.clone(),
        );
        server.start()?;
        Some(Arc::new(Mutex::new(server)))
    } else {
        None
    };

    Ok(TauriMcp {
        app: app.clone(),
        socket_server,
        application_name: config.application_name.clone(),
    })
}

/// Access to the tauri-mcp APIs.
pub struct TauriMcp<R: Runtime> {
    app: AppHandle<R>,
    socket_server: Option<Arc<Mutex<SocketServer<R>>>>,
    application_name: String,
}

impl<R: Runtime> TauriMcp<R> {
    pub fn ping(&self, payload: PingRequest) -> crate::Result<PingResponse> {
        Ok(PingResponse {
            value: payload.value,
        })
    }

    // Take screenshot - this feature depends on Tauri's window capabilities
    pub async fn take_screenshot_async(
        &self,
        payload: ScreenshotRequest,
    ) -> crate::Result<ScreenshotResponse> {
        let window_label = payload.window_label.clone();

        // Get window handle - supports both WebviewWindow and Window architectures
        let window_handle = get_window_handle(&self.app, &window_label)
            .ok_or_else(|| Error::WindowNotFound(window_label.clone()))?;

        // Create shared parameters struct from the request
        let params = ScreenshotParams {
            window_label: Some(window_label),
            quality: payload.quality,
            max_width: payload.max_width,
            max_size_mb: payload.max_size_mb,
            application_name: Some(self.application_name.clone()),
            output_dir: payload.output_dir,
            save_to_disk: payload.save_to_disk,
            thumbnail: payload.thumbnail,
        };

        // Create a context with the window handle for platform implementation
        let window_context = ScreenshotContext { window_handle };

        info!("[TAURI_MCP] Taking screenshot with default parameters");

        // Use platform-specific implementation to capture the window
        crate::platform::current::take_screenshot(params, window_context).await
    }

    // Add async method to perform window operations
    pub async fn manage_window_async(
        &self,
        params: WindowManagerRequest,
    ) -> Result<WindowManagerResponse> {
        let window_label = params.window_label.unwrap_or_else(|| "main".to_string());

        // Get the window by label - supports both WebviewWindow and Window architectures
        let window = get_window_handle(&self.app, &window_label).ok_or_else(|| {
            Error::WindowOperationFailed(format!("Window not found: {}", window_label))
        })?;

        // Execute the requested operation using WindowHandle methods
        match params.operation.as_str() {
            "minimize" => {
                window.minimize()?;
                Ok(WindowManagerResponse {
                    success: true,
                    error: None,
                })
            }
            "maximize" => {
                window.maximize()?;
                Ok(WindowManagerResponse {
                    success: true,
                    error: None,
                })
            }
            "unmaximize" => {
                window.unmaximize()?;
                Ok(WindowManagerResponse {
                    success: true,
                    error: None,
                })
            }
            "close" => {
                window.close()?;
                Ok(WindowManagerResponse {
                    success: true,
                    error: None,
                })
            }
            "show" => {
                window.show()?;
                Ok(WindowManagerResponse {
                    success: true,
                    error: None,
                })
            }
            "hide" => {
                window.hide()?;
                Ok(WindowManagerResponse {
                    success: true,
                    error: None,
                })
            }
            "setPosition" => {
                if let (Some(x), Some(y)) = (params.x, params.y) {
                    window.set_position(tauri::LogicalPosition::new(x as f64, y as f64))?;
                    Ok(WindowManagerResponse {
                        success: true,
                        error: None,
                    })
                } else {
                    Err(Error::WindowOperationFailed(
                        "setPosition requires x and y coordinates".to_string(),
                    ))
                }
            }
            "setSize" => {
                if let (Some(width), Some(height)) = (params.width, params.height) {
                    window.set_size(tauri::LogicalSize::new(width as f64, height as f64))?;
                    Ok(WindowManagerResponse {
                        success: true,
                        error: None,
                    })
                } else {
                    Err(Error::WindowOperationFailed(
                        "setSize requires width and height parameters".to_string(),
                    ))
                }
            }
            "center" => {
                window.center()?;
                Ok(WindowManagerResponse {
                    success: true,
                    error: None,
                })
            }
            "toggleFullscreen" => {
                let is_fullscreen = window.is_fullscreen()?;
                window.set_fullscreen(!is_fullscreen)?;
                Ok(WindowManagerResponse {
                    success: true,
                    error: None,
                })
            }
            "focus" => {
                window.set_focus()?;
                Ok(WindowManagerResponse {
                    success: true,
                    error: None,
                })
            }
            _ => Err(Error::WindowOperationFailed(format!(
                "Unknown window operation: {}",
                params.operation
            ))),
        }
    }

    // Text input simulation via native event injection (no Accessibility permissions needed)
    pub async fn simulate_text_input_async(
        &self,
        params: TextInputRequest,
    ) -> crate::Result<TextInputResponse> {
        let text = params.text;
        let delay_ms = params.delay_ms.unwrap_or(20);
        let initial_delay_ms = params.initial_delay_ms.unwrap_or(500);
        let window_label = params.window_label.as_deref().unwrap_or("main");

        // Resolve the webview for native event injection
        let webview = get_webview_for_eval(&self.app, window_label)
            .ok_or_else(|| Error::Anyhow(format!("Webview not found: {}", window_label)))?;

        // Initial delay before typing
        if initial_delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(initial_delay_ms)).await;
        }

        let start_time = Instant::now();

        let text_params = TextParams {
            text: text.clone(),
            delay_ms,
        };

        let result = native_input::backend::inject_text(&webview, &text_params)
            .map_err(|e| Error::Anyhow(format!("Native text injection failed: {}", e)))?;

        let duration_ms = start_time.elapsed().as_millis() as u64;

        Ok(TextInputResponse {
            chars_typed: result.chars_typed,
            duration_ms,
        })
    }

    // Mouse movement simulation
    pub async fn simulate_mouse_movement_async(
        &self,
        params: MouseMovementRequest,
    ) -> crate::Result<MouseMovementResponse> {
        mouse_movement::simulate_mouse_movement_async(&self.app, params).await
    }
}

impl<R: Runtime> Drop for TauriMcp<R> {
    fn drop(&mut self) {
        if let Some(server) = &self.socket_server {
            if let Ok(mut server) = server.lock() {
                let _ = server.stop();
            }
        }
    }
}
