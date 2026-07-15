use serde::{Deserialize, Serialize};

/// Shared interface traits and types for the MCP server and Tauri plugin
/// This ensures both sides maintain compatible function signatures
/// Common parameters for screenshot functionality
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotParams {
    /// The label of the window to capture
    pub window_label: Option<String>,

    /// JPEG quality (1-100)
    pub quality: Option<i32>,

    /// Maximum image width in pixels
    pub max_width: Option<i32>,

    /// Maximum file size in MB
    pub max_size_mb: Option<f32>,

    /// Application name to look for in window matching
    pub application_name: Option<String>,
}

/// Result of taking a screenshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotResult {
    /// Whether the operation was successful
    pub success: bool,

    /// Error message if operation failed
    pub error: Option<String>,

    /// Image data (if successful) in base64 format with MIME prefix
    pub data: Option<String>,

    /// MIME type of the image
    pub mime_type: Option<String>,
}

// Window manager operation parameters
#[derive(Debug, Serialize, Deserialize)]
pub struct WindowManagerParams {
    pub window_label: Option<String>,
    pub operation: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

// Window manager operation result
#[derive(Debug, Serialize, Deserialize)]
pub struct WindowManagerResult {
    pub success: bool,
    pub error: Option<String>,
}

// Text input parameters
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInputParams {
    pub text: String,
    pub delay_ms: Option<u64>,
    pub initial_delay_ms: Option<u64>,
}

// Text input result
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInputResult {
    pub success: bool,
    pub chars_typed: u32,
    pub duration_ms: u64,
    pub error: Option<String>,
}

// Mouse movement parameters
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseMovementParams {
    pub x: i32,
    pub y: i32,
    pub relative: Option<bool>,
    pub click: Option<bool>,
    pub button: Option<String>, // "left", "right", or "middle"
}

// Mouse movement result
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseMovementResult {
    pub success: bool,
    pub duration_ms: u64,
    pub position: Option<(i32, i32)>,
    pub error: Option<String>,
}

/// Main interface trait for MCP functionality
pub trait McpInterface {
    /// Takes a screenshot of the specified window
    fn take_screenshot_shared(
        &self,
        params: ScreenshotParams,
    ) -> std::result::Result<ScreenshotResult, String>;

    /// Manages window operations (resize, position, show/hide, etc.)
    fn manage_window_shared(
        &self,
        params: WindowManagerParams,
    ) -> std::result::Result<WindowManagerResult, String>;

    /// Simulates keyboard text input
    fn simulate_text_input_shared(
        &self,
        params: TextInputParams,
    ) -> std::result::Result<TextInputResult, String>;

    /// Simulates mouse movement
    fn simulate_mouse_movement_shared(
        &self,
        params: MouseMovementParams,
    ) -> std::result::Result<MouseMovementResult, String>;

    // Add other shared functions here
}

/// Command string constants for socket commands
pub mod commands {
    pub const PING: &str = "ping";
    pub const TAKE_SCREENSHOT: &str = "take_screenshot";
    pub const GET_DOM: &str = "get_dom";
    pub const MANAGE_LOCAL_STORAGE: &str = "manage_local_storage";
    pub const EXECUTE_JS: &str = "execute_js";
    pub const MANAGE_WINDOW: &str = "manage_window";
    pub const SIMULATE_TEXT_INPUT: &str = "simulate_text_input";
    pub const SIMULATE_MOUSE_MOVEMENT: &str = "simulate_mouse_movement";
    pub const GET_ELEMENT_POSITION: &str = "get_element_position";
    pub const SEND_TEXT_TO_ELEMENT: &str = "send_text_to_element";
    pub const HOT_RELOAD: &str = "hot_reload";
    pub const GET_CONSOLE_LOGS: &str = "get_console_logs";
    pub const INJECT_CONSOLE_CAPTURE: &str = "inject_console_capture";
    pub const NETWORK_INSPECTOR: &str = "network_inspector";
    pub const INJECT_NETWORK_CAPTURE: &str = "inject_network_capture";
    pub const STATE_DUMP: &str = "state_dump";
    pub const DEVTOOLS_BRIDGE: &str = "devtools_bridge";
    pub const GET_EXCEPTIONS: &str = "get_exceptions";
    pub const INJECT_ERROR_TRACKER: &str = "inject_error_tracker";
    pub const CLEAR_EXCEPTIONS: &str = "clear_exceptions";
    pub const GET_PERFORMANCE_METRICS: &str = "get_performance_metrics";
    pub const STORAGE_INSPECTOR: &str = "storage_inspector";
    pub const HEALTH_CHECK: &str = "health_check";
}
