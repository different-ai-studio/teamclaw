use crate::models::ScreenshotResponse;
use crate::{Error, Result};
use image::{DynamicImage, RgbaImage};
use log::info;
use tauri::Runtime;
use win_screenshot::prelude::*;

// Import shared functionality
use crate::desktop::ScreenshotContext;
use crate::platform::shared::{
    finalize_screenshot, find_matching_window, get_window_title_from_handle,
    handle_screenshot_task, WindowMatchCandidate,
};
use crate::shared::ScreenshotParams;

// Windows-specific implementation for taking screenshots
pub async fn take_screenshot<R: Runtime>(
    params: ScreenshotParams,
    window_context: ScreenshotContext<R>,
) -> Result<ScreenshotResponse> {
    // Clone params for use in the closure
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

    info!("[SCREENSHOT] Looking for window with title: {} (label: {})", window_title, window_label);

    // Get all windows
    let windows = match window_list() {
      Ok(list) => list,
      Err(e) => return Err(Error::WindowOperationFailed(format!("Failed to get window list: {:?}", e))),
    };

    info!("[SCREENSHOT] Found {} windows through win-screenshot", windows.len());

    // Log all windows with titles for debugging
    info!("[SCREENSHOT] ============= ALL WINDOWS =============");
    for window_info in &windows {
      info!("[SCREENSHOT] Window: hwnd={}, title='{}'",
              window_info.hwnd, window_info.window_name);
    }
    info!("[SCREENSHOT] ======================================");

    // Find the window via the shared matching ladder (exact, case-insensitive
    // and partial title fallbacks). win-screenshot's window list exposes only
    // hwnd + title, so app-name candidates are empty here; the app-name pass
    // simply finds no match and falls through to the title-based passes.
    let candidates: Vec<WindowMatchCandidate> = windows
      .iter()
      .map(|w| WindowMatchCandidate {
        title: w.window_name.clone(),
        app_name: String::new(),
        is_minimized: false,
      })
      .collect();

    let target_hwnd = find_matching_window(&candidates, &window_title, &application_name)
      .map(|i| windows[i].hwnd);

    // Take screenshot if a window was found
    if let Some(hwnd) = target_hwnd {
      info!("[SCREENSHOT] Taking screenshot of window with hwnd: {}", hwnd);
      
      // Use PrintWindow for more reliable capture
      let buffer = match capture_window_ex(hwnd, Using::PrintWindow, Area::Full, None, None) {
        Ok(buf) => buf,
        Err(e) => return Err(Error::WindowOperationFailed(format!("Failed to capture window: {:?}", e))),
      };
      
      info!("[SCREENSHOT] Successfully captured window image: {}x{}", 
              buffer.width, buffer.height);
      
      // Convert to dynamic image for processing
      let dynamic_image = DynamicImage::ImageRgba8(
        RgbaImage::from_raw(buffer.width, buffer.height, buffer.pixels)
          .ok_or_else(|| Error::WindowOperationFailed("Failed to create image from buffer".to_string()))?
      );
      
      // Process the image
      finalize_screenshot(dynamic_image, &params_clone)
    } else {
      // No window found at all
      Err(Error::WindowOperationFailed("Window not found using any detection method. Please ensure the window is visible and not minimized.".to_string()))
    }
  }).await
}
