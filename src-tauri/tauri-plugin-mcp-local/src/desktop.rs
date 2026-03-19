use crate::error::Error;
use crate::models::*;
use crate::shared::{
    McpInterface, MouseMovementParams, MouseMovementResult, ScreenshotParams,
    ScreenshotResult as SharedScreenshotResult, TextInputParams, TextInputResult,
    WindowManagerParams, WindowManagerResult,
};
use crate::socket_server::SocketServer;
use crate::tools::mouse_movement;
use crate::{PluginConfig, Result};
use enigo::{Enigo, Keyboard, Settings};
use serde::de::DeserializeOwned;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime, plugin::PluginApi};
use log::info;

// ----- Screenshot Utilities -----

/// Helper structure to hold window for screenshot functions
pub struct ScreenshotContext<R: Runtime> {
    pub window: tauri::WebviewWindow<R>,
}

/// Create a success response with data
pub fn create_success_response(data_url: String) -> ScreenshotResponse {
    ScreenshotResponse {
        data: Some(data_url),
        success: true,
        error: None,
    }
}

/// Create an error response
pub fn create_error_response(error_msg: String) -> ScreenshotResponse {
    ScreenshotResponse {
        data: None,
        success: false,
        error: Some(error_msg),
    }
}

// ----- TauriMcp Implementation -----

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
    config: &PluginConfig,
) -> crate::Result<TauriMcp<R>> {
    let socket_server = if config.start_socket_server {
        let mut server = SocketServer::new(app.clone(), config.socket_type.clone());
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

        let window = self
            .app
            .get_webview_window(&window_label)
            .ok_or_else(|| Error::window_not_found(window_label.clone()))?;

        // Create shared parameters struct from the request
        let params = ScreenshotParams {
            window_label: Some(window_label),
            quality: None,
            max_width: None,
            max_size_mb: None,
            application_name: Some(self.application_name.clone()),
        };

        // Create a context with the window for platform implementation
        let window_context = ScreenshotContext {
            window: window.clone(),
        };

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

        // Get the window by label
        let window = self.app.get_webview_window(&window_label).ok_or_else(|| {
            Error::window_operation_failed("get_window", format!("Window not found: {}", window_label))
        })?;

        // Execute the requested operation
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
                    window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                        x,
                        y,
                    }))?;
                    Ok(WindowManagerResponse {
                        success: true,
                        error: None,
                    })
                } else {
                    Err(Error::invalid_parameter(
                        "setPosition",
                        "x and y coordinates",
                        "missing x or y",
                    ))
                }
            }
            "setSize" => {
                if let (Some(width), Some(height)) = (params.width, params.height) {
                    window
                        .set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }))?;
                    Ok(WindowManagerResponse {
                        success: true,
                        error: None,
                    })
                } else {
                    Err(Error::invalid_parameter(
                        "setSize",
                        "width and height",
                        "missing width or height",
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
            _ => Err(Error::invalid_parameter(
                "window operation",
                "minimize|maximize|unmaximize|close|show|hide|setPosition|setSize|center|toggleFullscreen|focus",
                &params.operation,
            )),
        }
    }

    // Text input simulation
    pub async fn simulate_text_input_async(
        &self,
        params: TextInputRequest,
    ) -> crate::Result<TextInputResponse> {
        let text = params.text;
        let delay_ms = params.delay_ms.unwrap_or(20);
        let initial_delay_ms = params.initial_delay_ms.unwrap_or(500);

        // Create Enigo instance with the latest API
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| Error::communication_error(format!("Failed to initialize Enigo: {}", e)))?;

        // Initial delay before typing
        if initial_delay_ms > 0 {
            thread::sleep(Duration::from_millis(initial_delay_ms));
        }

        let start_time = Instant::now();

        // Use the text method from the Keyboard trait
        if delay_ms == 0 {
            // Fast typing (all at once)
            Keyboard::text(&mut enigo, &text)
                .map_err(|e| Error::communication_error(format!("Failed to simulate text input: {}", e)))?;
        } else {
            // Slow typing with configurable delay
            for c in text.chars() {
                Keyboard::text(&mut enigo, &c.to_string())
                    .map_err(|e| Error::communication_error(format!("Failed to simulate text input: {}", e)))?;

                thread::sleep(Duration::from_millis(delay_ms));
            }
        }

        let duration_ms = start_time.elapsed().as_millis() as u64;

        Ok(TextInputResponse {
            chars_typed: text.chars().count() as u32,
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
            if let Ok(server) = server.lock() {
                let _ = server.stop();
            }
        }
    }
}

// Let's implement the interface properly
impl<R: Runtime> McpInterface for TauriMcp<R> {
    fn take_screenshot_shared(
        &self,
        params: ScreenshotParams,
    ) -> std::result::Result<SharedScreenshotResult, String> {
        // Create a ScreenshotRequest from our interface params
        let window_label = params.window_label.unwrap_or_else(|| "main".to_string());

        let request = ScreenshotRequest { window_label };
        match futures::executor::block_on(self.take_screenshot_async(request)) {
            Ok(response) => {
                // Convert to the shared result type
                Ok(SharedScreenshotResult {
                    success: response.success,
                    error: response.error,
                    data: response.data,
                    mime_type: Some("image/jpeg".to_string()),
                })
            }
            Err(err) => {
                // Convert the error type
                Err(err.to_string())
            }
        }
    }

    fn manage_window_shared(
        &self,
        params: WindowManagerParams,
    ) -> std::result::Result<WindowManagerResult, String> {
        // Convert from shared types to internal types
        let request = WindowManagerRequest {
            window_label: params.window_label,
            operation: params.operation,
            x: params.x,
            y: params.y,
            width: params.width,
            height: params.height,
        };

        // Call the async method in a blocking manner
        match tokio::runtime::Handle::current().block_on(self.manage_window_async(request)) {
            Ok(response) => Ok(WindowManagerResult {
                success: response.success,
                error: response.error,
            }),
            Err(e) => Err(e.to_string()),
        }
    }

    fn simulate_text_input_shared(
        &self,
        params: TextInputParams,
    ) -> std::result::Result<TextInputResult, String> {
        // Use the current tokio runtime handle instead of creating a new one
        let handle = tokio::runtime::Handle::current();

        // Convert shared params to internal type
        let request = TextInputRequest {
            text: params.text,
            delay_ms: params.delay_ms,
            initial_delay_ms: params.initial_delay_ms,
        };

        // Run async method
        let result = handle.block_on(self.simulate_text_input_async(request));

        // Convert result to shared type
        match result {
            Ok(response) => Ok(TextInputResult {
                success: true,
                chars_typed: response.chars_typed,
                duration_ms: response.duration_ms,
                error: None,
            }),
            Err(e) => Ok(TextInputResult {
                success: false,
                chars_typed: 0,
                duration_ms: 0,
                error: Some(e.to_string()),
            }),
        }
    }

    fn simulate_mouse_movement_shared(
        &self,
        params: MouseMovementParams,
    ) -> std::result::Result<MouseMovementResult, String> {
        crate::tools::mouse_movement::simulate_mouse_movement_shared(&self.app, params)
    }
}
