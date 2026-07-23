use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::socket_server::SocketResponse;

impl SocketResponse {
    /// Build a successful response with an optional data payload.
    pub fn ok(id: Option<String>, data: Option<Value>) -> Self {
        Self {
            success: true,
            data,
            error: None,
            id,
        }
    }

    /// Build a failed response with an error message.
    pub fn err(id: Option<String>, error: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
            id,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingRequest {
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowListResponse {
    pub windows: Vec<WindowInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub label: String,
    pub title: String,
    pub is_visible: bool,
    pub is_focused: bool,
    pub is_maximized: bool,
    pub is_fullscreen: bool,
}

// Screenshot request - updated to use shared interface
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotRequest {
    #[serde(alias = "window_label")]
    pub window_label: String,
    pub quality: Option<i32>,
    #[serde(alias = "max_width")]
    pub max_width: Option<i32>,
    #[serde(alias = "max_size_mb")]
    pub max_size_mb: Option<f32>,
    #[serde(alias = "output_dir")]
    pub output_dir: Option<String>,
    #[serde(alias = "save_to_disk")]
    pub save_to_disk: Option<bool>,
    pub thumbnail: Option<bool>,
}

impl From<ScreenshotRequest> for crate::shared::ScreenshotParams {
    fn from(req: ScreenshotRequest) -> Self {
        Self {
            window_label: Some(req.window_label),
            quality: req.quality,
            max_width: req.max_width,
            max_size_mb: req.max_size_mb,
            application_name: None,
            output_dir: req.output_dir,
            save_to_disk: req.save_to_disk,
            thumbnail: req.thumbnail,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResponse {
    pub data: Option<String>, // Base64 encoded image
    pub success: bool,
    pub error: Option<String>,
    pub file_path: Option<String>,
}

impl From<crate::shared::ScreenshotResult> for ScreenshotResponse {
    fn from(result: crate::shared::ScreenshotResult) -> Self {
        Self {
            data: result.data,
            success: result.success,
            error: result.error,
            file_path: result.file_path,
        }
    }
}

// LocalStorage request model
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalStorageRequest {
    pub action: String,
    pub key: Option<String>,
    pub value: Option<String>,
    pub window_label: Option<String>,
}

// Window manager request model
#[derive(Debug, Deserialize, Serialize)]
pub struct WindowManagerRequest {
    pub window_label: Option<String>,
    pub operation: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

// Window manager response model
#[derive(Debug, Serialize)]
pub struct WindowManagerResponse {
    pub success: bool,
    pub error: Option<String>,
}

// TextInput request model
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInputRequest {
    pub text: String,
    pub delay_ms: Option<u64>,
    pub initial_delay_ms: Option<u64>,
    #[serde(default, alias = "window_label")]
    pub window_label: Option<String>,
}

// TextInput response model
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInputResponse {
    pub chars_typed: u32,
    pub duration_ms: u64,
}

// Mouse movement request model
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseMovementRequest {
    pub x: i32,
    pub y: i32,
    pub relative: Option<bool>,
    pub click: Option<bool>,
    pub button: Option<String>, // "left", "right", or "middle"
    #[serde(default, alias = "window_label")]
    pub window_label: Option<String>,
    #[serde(default, alias = "mouse_down")]
    pub mouse_down: Option<bool>,
    #[serde(default, alias = "mouse_up")]
    pub mouse_up: Option<bool>,
}

// Mouse movement response model
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseMovementResponse {
    pub success: bool,
    pub duration_ms: u64,
    pub position: Option<(i32, i32)>,
}

// Restart app request model
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartAppRequest {
    /// Delay in ms before restart (default 500, clamped to 100-5000)
    pub delay_ms: Option<u64>,
}
