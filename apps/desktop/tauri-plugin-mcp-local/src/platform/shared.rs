use crate::desktop::{create_error_response, create_success_response, WindowHandle};
use crate::models::ScreenshotResponse;
use crate::shared::ScreenshotParams;
use crate::tools::take_screenshot::{process_image, process_image_to_file, process_thumbnail};
use crate::{Error, Result};
use image::DynamicImage;
use log::{debug, error, info};
use tauri::Runtime;

// Common function for handling the screenshot task and response
pub async fn handle_screenshot_task<F>(screenshot_fn: F) -> Result<ScreenshotResponse>
where
    F: FnOnce() -> Result<ScreenshotResponse> + Send + 'static,
{
    // Execute the platform-specific screenshot function in a blocking task
    let result = tokio::task::spawn_blocking(screenshot_fn)
        .await
        .map_err(|e| Error::WindowOperationFailed(format!("Task join error: {}", e)))?;

    // Handle the result consistently across platforms
    match result {
        Ok(response) => Ok(response),
        Err(e) => Ok(create_error_response(format!("{}", e))),
    }
}


/// Finalize a screenshot capture: branches on save_to_disk/thumbnail params to produce the right response.
pub fn finalize_screenshot(
    dynamic_image: DynamicImage,
    params: &ScreenshotParams,
) -> Result<ScreenshotResponse> {
    let save_to_disk = params.save_to_disk.unwrap_or(false);
    let thumbnail = params.thumbnail.unwrap_or(false);

    // Determine output directory
    let output_dir = params.output_dir.clone().unwrap_or_else(|| {
        let dir = std::env::temp_dir().join("tauri-mcp-screenshots");
        dir.to_string_lossy().to_string()
    });

    match (save_to_disk, thumbnail) {
        // Combo mode: save full image to disk + return thumbnail inline
        (true, true) => {
            let file_path = process_image_to_file(dynamic_image.clone(), params, &output_dir)?;
            let thumb_data_url = process_thumbnail(dynamic_image)?;
            info!("[SCREENSHOT] Combo mode: thumbnail inline + file at {}", file_path);
            Ok(ScreenshotResponse {
                data: Some(thumb_data_url),
                success: true,
                error: None,
                file_path: Some(file_path),
            })
        }
        // Save to disk only: no inline data
        (true, false) => {
            let file_path = process_image_to_file(dynamic_image, params, &output_dir)?;
            info!("[SCREENSHOT] Save-to-disk mode: file at {}", file_path);
            Ok(ScreenshotResponse {
                data: None,
                success: true,
                error: None,
                file_path: Some(file_path),
            })
        }
        // Thumbnail only: return small thumbnail inline, no file
        (false, true) => {
            let thumb_data_url = process_thumbnail(dynamic_image)?;
            info!("[SCREENSHOT] Thumbnail-only mode");
            Ok(ScreenshotResponse {
                data: Some(thumb_data_url),
                success: true,
                error: None,
                file_path: None,
            })
        }
        // Default: return full inline base64
        (false, false) => {
            let data_url = process_image(dynamic_image, params)?;
            Ok(create_success_response(data_url))
        }
    }
}

/// Platform-agnostic view of a native window, used for shared window matching.
#[derive(Debug, Clone)]
pub struct WindowMatchCandidate {
    pub title: String,
    pub app_name: String,
    pub is_minimized: bool,
}

/// Shared window-matching ladder used by all platforms.
///
/// Returns the index of the best matching candidate, trying in order:
/// 1. Application name contains match (only when `application_name` is non-empty)
/// 2. Exact window title match
/// 3. Case-insensitive window title match
/// 4. Partial window title match (candidate title contains the search title)
/// 5. Cross app-name/title partial match (app name appears in the requested
///    title or vice versa; candidates with empty app names are skipped)
///
/// Minimized windows are always skipped.
pub fn find_matching_window(
    candidates: &[WindowMatchCandidate],
    window_title: &str,
    application_name: &str,
) -> Option<usize> {
    let application_name_lower = application_name.to_lowercase();
    let window_title_lower = window_title.to_lowercase();

    info!(
        "[TAURI-MCP] Searching for window with title: '{}', app_name: '{}' (case-insensitive)",
        window_title, application_name
    );

    debug!("[TAURI-MCP] ============= ALL WINDOWS =============");
    for candidate in candidates {
        debug!(
            "[TAURI-MCP] Window: title='{}', app_name='{}', minimized={}",
            candidate.title, candidate.app_name, candidate.is_minimized
        );
    }
    debug!("[TAURI-MCP] ======================================");

    let visible = |c: &&(usize, &WindowMatchCandidate)| !c.1.is_minimized;
    let indexed: Vec<(usize, &WindowMatchCandidate)> = candidates.iter().enumerate().collect();

    // Step 1: Direct application name match (highest priority)
    if !application_name_lower.is_empty() {
        for (i, c) in indexed.iter().filter(visible) {
            if c.app_name.to_lowercase().contains(&application_name_lower) {
                info!("[TAURI-MCP] Found window by app name: '{}'", c.app_name);
                return Some(*i);
            }
        }
    }

    // Step 2: Exact window title match
    for (i, c) in indexed.iter().filter(visible) {
        if c.title == window_title {
            info!("[TAURI-MCP] Found window by exact title match: '{}'", c.title);
            return Some(*i);
        }
    }

    // Step 3: Case-insensitive window title match
    for (i, c) in indexed.iter().filter(visible) {
        if c.title.to_lowercase() == window_title_lower {
            info!(
                "[TAURI-MCP] Found window by case-insensitive title match: '{}'",
                c.title
            );
            return Some(*i);
        }
    }

    // Step 4: Partial window title match (title contains search string)
    if !window_title_lower.is_empty() {
        for (i, c) in indexed.iter().filter(visible) {
            if c.title.to_lowercase().contains(&window_title_lower) {
                info!("[TAURI-MCP] Found window by partial title match: '{}'", c.title);
                return Some(*i);
            }
        }
    }

    // Step 5: Partial app name / title cross match
    for (i, c) in indexed.iter().filter(visible) {
        let app_name = c.app_name.to_lowercase();
        if app_name.is_empty() {
            continue;
        }
        if app_name.contains(&window_title_lower) || window_title_lower.contains(&app_name) {
            info!(
                "[TAURI-MCP] Found window by partial app name match: '{}'",
                c.app_name
            );
            return Some(*i);
        }
    }

    error!(
        "[TAURI-MCP] No matching window found for title='{}', app_name='{}'",
        window_title, application_name
    );
    None
}

// Helper function to get window title from WindowHandle - supports both architectures
pub fn get_window_title_from_handle<R: Runtime>(handle: &WindowHandle<R>) -> Result<String> {
    match handle {
        WindowHandle::WebviewWindow(w) => match w.title() {
            Ok(title) => Ok(title),
            Err(e) => Err(Error::WindowOperationFailed(format!(
                "Failed to get window title: {}",
                e
            ))),
        },
        WindowHandle::Window(w) => match w.title() {
            Ok(title) => Ok(title),
            Err(e) => Err(Error::WindowOperationFailed(format!(
                "Failed to get window title: {}",
                e
            ))),
        },
    }
}
