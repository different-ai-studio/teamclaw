use serde::{Deserialize, Serialize};

pub mod state;
pub mod js_fallback;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub mod unix;

// Re-export the current platform backend under a common name
#[cfg(target_os = "macos")]
pub use self::macos as backend;

#[cfg(target_os = "windows")]
pub use self::windows as backend;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use self::unix as backend;

/// Release any OS-level mouse button left held open by an interrupted
/// `mouse_down`-only call (a drag whose `mouse_up` never arrived). Call this
/// when a client connection ends so a dropped drag can't wedge the real
/// cursor's button. No-op on platforms whose backend does not hold mouse
/// button state across separate requests.
pub fn release_held_buttons() {
    #[cfg(target_os = "macos")]
    backend::release_held_buttons();
}

/// Mouse button types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

impl MouseButton {
    pub fn from_str_opt(s: Option<&str>) -> Self {
        match s {
            Some("right") => MouseButton::Right,
            Some("middle") => MouseButton::Middle,
            _ => MouseButton::Left,
        }
    }
}

/// Parameters for mouse event injection
#[derive(Debug, Clone)]
pub struct MouseParams {
    pub x: i32,
    pub y: i32,
    pub click: bool,
    pub button: MouseButton,
    pub mouse_down: bool,
    pub mouse_up: bool,
}

/// Parameters for text event injection
#[derive(Debug, Clone)]
pub struct TextParams {
    pub text: String,
    pub delay_ms: u64,
}

/// Result of a mouse injection operation
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct InputResult {
    pub success: bool,
    pub position: (i32, i32),
    pub error: Option<String>,
}

/// Result of a text injection operation
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct TextResult {
    pub success: bool,
    pub chars_typed: u32,
    pub error: Option<String>,
}
