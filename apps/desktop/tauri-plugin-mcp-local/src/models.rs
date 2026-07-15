use serde::{Deserialize, Serialize};

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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowControlRequest {
    pub window_label: String,
    pub action: WindowAction,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowAction {
    Minimize,
    Maximize,
    Unmaximize,
    Close,
    Show,
    Hide,
    SetTitle { title: String },
    SetPosition { x: f64, y: f64 },
    SetSize { width: f64, height: f64 },
    SetFullscreen { fullscreen: bool },
    Center,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowControlResponse {
    pub success: bool,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowListRequest {}

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

// New MCP JavaScript execution models
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalJsRequest {
    pub window_label: String,
    pub script: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalJsResponse {
    pub result: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

// Element related models
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementRequest {
    pub window_label: String,
    pub selector: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetElementValueRequest {
    pub window_label: String,
    pub selector: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementResponse {
    pub value: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

// Type text into focused element
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeTextRequest {
    pub window_label: String,
    pub text: String,
}

// Screenshot request - updated to use shared interface
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ScreenshotRequest {
    pub window_label: String,
}

impl From<ScreenshotRequest> for crate::shared::ScreenshotParams {
    fn from(req: ScreenshotRequest) -> Self {
        Self {
            window_label: Some(req.window_label),
            quality: None,
            max_width: None,
            max_size_mb: None,
            application_name: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResponse {
    pub data: Option<String>, // Base64 encoded image
    pub success: bool,
    pub error: Option<String>,
}

impl From<crate::shared::ScreenshotResult> for ScreenshotResponse {
    fn from(result: crate::shared::ScreenshotResult) -> Self {
        Self {
            data: result.data,
            success: result.success,
            error: result.error,
        }
    }
}

// URL and title requests
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewInfoRequest {
    pub window_label: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlResponse {
    pub url: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleResponse {
    pub title: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlResponse {
    pub html: Option<String>,
    pub success: bool,
    pub error: Option<String>,
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
#[derive(Debug, Deserialize)]
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
}

// Mouse movement response model
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseMovementResponse {
    pub success: bool,
    pub duration_ms: u64,
    pub position: Option<(i32, i32)>,
}
