//! Tauri invoke command that lets the webview push console/error logs into
//! the Rust-side ring buffer. Used by the `console.*` interception
//! installed by `listener_patch.js`. Kept extremely small: no validation
//! beyond clamping the level string to known values, since this is a
//! best-effort observability channel.

use crate::log_buffer::{self, LogSource};

#[tauri::command]
pub fn push_log(
    level: Option<String>,
    message: Option<String>,
    target: Option<String>,
) -> Result<(), String> {
    let level = match level.as_deref().map(str::to_ascii_lowercase).as_deref() {
        Some("error") => "error",
        Some("warn") | Some("warning") => "warn",
        Some("info") => "info",
        Some("debug") => "debug",
        Some("trace") | Some("log") => "trace",
        _ => "info",
    };
    let message = message.unwrap_or_default();
    log_buffer::global().push(level, LogSource::Js, target, message);
    Ok(())
}
