use crate::models::ScreenshotResponse;
use crate::{Error, Result};
use image;
use log::info;
use tauri::Runtime;

// Import shared functionality
use crate::desktop::ScreenshotContext;
use crate::platform::shared::{
    finalize_screenshot, find_matching_window, get_window_title_from_handle,
    handle_screenshot_task, WindowMatchCandidate,
};
use crate::shared::ScreenshotParams;

// Linux/Unix implementation for taking screenshots using xcap
pub async fn take_screenshot<R: Runtime>(
    params: ScreenshotParams,
    window_context: ScreenshotContext<R>,
) -> Result<ScreenshotResponse> {
    // Clone necessary parameters for use in the closure
    let params_clone = params.clone();
    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Get application name from params or use a default
    let application_name = params.application_name.clone().unwrap_or_default();

    // Get window title from the handle (works with both Window and WebviewWindow)
    let window_title = get_window_title_from_handle(&window_context.window_handle)?;

    handle_screenshot_task(move || {
        info!("[TAURI-MCP] Looking for window with title: {} (label: {})", window_title, window_label);

        // Get all windows using xcap
        let xcap_windows = match xcap::Window::all() {
            Ok(windows) => windows,
            Err(e) => return Err(Error::WindowOperationFailed(format!("Failed to get window list: {}", e))),
        };

        info!("[TAURI-MCP] Found {} windows through xcap", xcap_windows.len());

        // Find the target window
        if let Some(window) = find_window(&xcap_windows, &window_title, &application_name) {
            // Capture image directly from the window
            let image = match window.capture_image() {
                Ok(img) => img,
                Err(e) => return Err(Error::WindowOperationFailed(format!("Failed to capture window image: {}", e))),
            };

            info!("[TAURI-MCP] Successfully captured window image: {}x{}",
                  image.width(), image.height());

            // Convert to DynamicImage for further processing
            let dynamic_image = image::DynamicImage::ImageRgba8(image);

            finalize_screenshot(dynamic_image, &params_clone)
        } else {
            Err(Error::WindowOperationFailed(
                format!("Window not found. Searched for title='{}', app='{}'. \
                Found {} xcap windows. Please ensure the window is visible and not minimized.",
                window_title, application_name, xcap_windows.len())
            ))
        }
    }).await
}

// Helper function to find the window in the xcap window list.
// Delegates the matching ladder to the shared cross-platform helper.
fn find_window(xcap_windows: &[xcap::Window], window_title: &str, application_name: &str) -> Option<xcap::Window> {
    let candidates: Vec<WindowMatchCandidate> = xcap_windows
        .iter()
        .map(|w| WindowMatchCandidate {
            // xcap 0.9 returns Result from these accessors
            title: w.title().unwrap_or_default(),
            app_name: w.app_name().unwrap_or_default(),
            is_minimized: w.is_minimized().unwrap_or(false),
        })
        .collect();

    find_matching_window(&candidates, window_title, application_name)
        .map(|i| xcap_windows[i].clone())
}
