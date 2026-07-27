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

    /// Directory to save screenshot file to (for save-to-disk mode)
    pub output_dir: Option<String>,

    /// If true, save to disk instead of returning inline base64
    pub save_to_disk: Option<bool>,

    /// If true, generate a small thumbnail for inline use
    pub thumbnail: Option<bool>,
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

    /// File path if screenshot was saved to disk
    pub file_path: Option<String>,
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
    #[serde(default)]
    pub window_label: Option<String>,
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
    #[serde(default)]
    pub window_label: Option<String>,
    #[serde(default)]
    pub mouse_down: Option<bool>,
    #[serde(default)]
    pub mouse_up: Option<bool>,
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
    pub const GET_PAGE_MAP: &str = "get_page_map";
    pub const GET_PAGE_STATE: &str = "get_page_state";
    pub const NAVIGATE_BACK: &str = "navigate_back";
    pub const SCROLL_PAGE: &str = "scroll_page";
    pub const FILL_FORM: &str = "fill_form";
    pub const WAIT_FOR: &str = "wait_for";
    pub const GET_APP_INFO: &str = "get_app_info";
    pub const LIST_WINDOWS: &str = "list_windows";
    pub const NAVIGATE_WEBVIEW: &str = "navigate_webview";
    pub const MANAGE_EVENTS: &str = "manage_events";
    pub const MANAGE_COOKIES: &str = "manage_cookies";
    pub const MANAGE_DEVTOOLS: &str = "manage_devtools";
    pub const MANAGE_ZOOM: &str = "manage_zoom";
    pub const MANAGE_WEBVIEW_STATE: &str = "manage_webview_state";
    pub const TYPE_INTO_FOCUSED: &str = "type_into_focused";
    pub const PRESS_KEY: &str = "press_key";
    pub const SET_FILE_INPUT: &str = "set_file_input";
    pub const MANAGE_IPC: &str = "manage_ipc";
    pub const RESTART_APP: &str = "restart_app";
    pub const QUERY_LOGS: &str = "query_logs";
    pub const LOG_MARK: &str = "log_mark";
    pub const READ_TEXT: &str = "read_text";
    pub const INSPECT_ELEMENT: &str = "inspect_element";
    pub const DISPATCH_POINTER: &str = "dispatch_pointer";
    pub const APP_BRIDGE: &str = "app_bridge";
}
