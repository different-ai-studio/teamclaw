use crate::models::ScreenshotResponse;
use crate::{Error, Result};
use image::{DynamicImage, RgbaImage};
use log::info;
use tauri::Runtime;
use win_screenshot::prelude::*;

// Import shared functionality
use crate::desktop::{ScreenshotContext, create_success_response};
use crate::platform::shared::{get_window_title, handle_screenshot_task};
use crate::shared::ScreenshotParams;
use crate::tools::take_screenshot::process_image;

// Windows-specific implementation for taking screenshots
pub async fn take_screenshot<R: Runtime>(
    params: ScreenshotParams,
    window_context: ScreenshotContext<R>,
) -> Result<ScreenshotResponse> {
    // Clone params for use in the closure
    let params_clone = params.clone();
    let window_clone = window_context.window.clone();
    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    handle_screenshot_task(move || {
    // Get the window title to help identify the right window
    let window_title = get_window_title(&window_clone)?;
    
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
    
    // Try to find the window
    let mut target_hwnd = None;
    
    // First try exact match
    for window_info in &windows {
      if window_info.window_name == window_title {
        info!("[SCREENSHOT] Found exact window title match: {}", window_info.window_name);
        target_hwnd = Some(window_info.hwnd);
        break;
      }
    }
   
  
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
      match process_image(dynamic_image, &params_clone) {
        Ok(data_url) => Ok(create_success_response(data_url)),
        Err(e) => Err(e),
      }
    } else {
      // No window found at all
      Err(Error::WindowOperationFailed("Window not found using any detection method. Please ensure the window is visible and not minimized.".to_string()))
    }
  }).await
}
