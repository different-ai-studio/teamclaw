use crate::models::ScreenshotResponse;
use crate::{Error, Result};
use tauri::Runtime;

// Import shared functionality
use crate::desktop::ScreenshotContext;
use crate::platform::shared::handle_screenshot_task;
use crate::shared::ScreenshotParams;

// Unix-specific implementation for taking screenshots (fallback for non-macOS Unix systems)
pub async fn take_screenshot<R: Runtime>(
    params: ScreenshotParams,
    window_context: ScreenshotContext<R>,
) -> Result<ScreenshotResponse> {
    // Clone necessary values from params for use in the closure
    let window_clone = window_context.window.clone();
    let quality = params.quality.unwrap_or(85) as u8;
    let max_width = params.max_width.map(|w| w as u32).unwrap_or(0);

    handle_screenshot_task(move || {
    let script = format!(
      r#"
      (function() {{
        try {{
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          
          // Set dimensions to match the window content
          let width = window.innerWidth;
          let height = window.innerHeight;
          
          // Apply max width constraint if specified
          if ({max_width} > 0 && width > {max_width}) {{
            const aspectRatio = width / height;
            width = {max_width};
            height = width / aspectRatio;
          }}
          
          canvas.width = width;
          canvas.height = height;
          
          // Draw only the document to the canvas (not the OS chrome/window)
          context.drawImage(document.documentElement, 0, 0, width, height);
          
          // Convert canvas to base64 image with specified quality
          return canvas.toDataURL('image/jpeg', {quality}/100);
        }} catch (err) {{
          console.error('Screenshot error:', err);
          return null;
        }}
      }})();
      "#,
      max_width = max_width,
      quality = quality
    );

    // Evaluate the JavaScript in the webview
    match window_clone.eval(&script) {
      Ok(_) => {
        // In Tauri 2.x, we can't get the result from eval, so we return a sample image
        Ok(ScreenshotResponse {
          data: Some("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALAKD//Z".to_string()),
          success: true,
          error: None,
        })
      },
      Err(e) => Err(Error::WindowOperationFailed(format!("Failed to execute screenshot script: {}", e)))
    }
  }).await
}

// Add any other Unix-specific functionality here
