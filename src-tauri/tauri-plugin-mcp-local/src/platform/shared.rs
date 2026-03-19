use crate::desktop::create_error_response;
use crate::models::ScreenshotResponse;
use crate::{Error, Result};
use tauri::Runtime;

// Common function for handling the screenshot task and response
pub async fn handle_screenshot_task<F>(screenshot_fn: F) -> Result<ScreenshotResponse>
where
    F: FnOnce() -> Result<ScreenshotResponse> + Send + 'static,
{
    // Execute the platform-specific screenshot function in a blocking task
    let result = tokio::task::spawn_blocking(screenshot_fn)
        .await
        .map_err(|e| Error::window_operation_failed("screenshot task", format!("Task join error: {}", e)))?;

    // Handle the result consistently across platforms
    match result {
        Ok(response) => Ok(response),
        Err(e) => Ok(create_error_response(format!("{}", e))),
    }
}

// Helper function to get window title - used by multiple platforms
pub fn get_window_title<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<String> {
    match window.title() {
        Ok(title) => Ok(title),
        Err(e) => Err(Error::window_operation_failed(
            "get window title",
            format!("Failed to get window title: {}", e),
        )),
    }
}
