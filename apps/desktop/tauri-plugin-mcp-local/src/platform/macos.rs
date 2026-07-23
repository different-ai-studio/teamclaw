use crate::models::ScreenshotResponse;
use crate::{Error, Result};
use image;
use log::{error, info};
use tauri::Runtime;
use core_graphics::display::{
    CGWindowListCopyWindowInfo, kCGWindowListOptionAll, kCGWindowListOptionIncludingWindow,
    kCGWindowListExcludeDesktopElements,
    kCGNullWindowID, CGWindowListCreateImage, CGRect, CGPoint, CGSize,
    kCGWindowImageDefault, kCGWindowImageBoundsIgnoreFraming,
};
use core_graphics::base::CGFloat;

// Import shared functionality
use crate::desktop::ScreenshotContext;
use crate::platform::shared::{
    finalize_screenshot, find_matching_window, get_window_title_from_handle,
    handle_screenshot_task, WindowMatchCandidate,
};
use crate::shared::ScreenshotParams;

/// Window info extracted from CGWindowListCopyWindowInfo
#[derive(Debug, Clone)]
struct WindowInfo {
    window_id: u32,
    owner_name: String,
    owner_pid: i32,
    name: String,
    layer: i32,
    bounds: (f64, f64, f64, f64), // x, y, width, height
}

/// Get all windows using CGWindowListCopyWindowInfo with kCGWindowListOptionAll
/// This finds windows that xcap's kCGWindowListOptionOnScreenOnly misses (like Tauri windows)
fn get_all_windows_cg() -> Vec<WindowInfo> {
    use core_foundation::base::TCFType;
    use core_foundation::array::CFArray;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    let mut windows = Vec::new();

    unsafe {
        let options = kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements;
        let window_list = CGWindowListCopyWindowInfo(options, kCGNullWindowID);

        if window_list.is_null() {
            return windows;
        }

        let array: CFArray = CFArray::wrap_under_create_rule(window_list);

        for i in 0..array.len() {
            let dict_ref = match array.get(i as isize) {
                Some(r) => r,
                None => continue,
            };

            // Cast to CFDictionary - the dict_ref is a raw pointer
            let dict_ptr = *dict_ref as *const core_foundation::dictionary::__CFDictionary;
            let dict: CFDictionary<CFString, *const std::ffi::c_void> =
                CFDictionary::wrap_under_get_rule(dict_ptr);

            // Extract window properties
            let owner_name = get_string_from_dict(&dict, "kCGWindowOwnerName").unwrap_or_default();
            let owner_pid = get_number_from_dict(&dict, "kCGWindowOwnerPID").unwrap_or(0) as i32;
            let name = get_string_from_dict(&dict, "kCGWindowName").unwrap_or_default();
            let layer = get_number_from_dict(&dict, "kCGWindowLayer").unwrap_or(-1) as i32;
            let window_id = get_number_from_dict(&dict, "kCGWindowNumber").unwrap_or(0) as u32;

            // Get bounds
            let bounds = get_bounds_from_dict(&dict);

            windows.push(WindowInfo {
                window_id,
                owner_name,
                owner_pid,
                name,
                layer,
                bounds,
            });
        }
    }

    windows
}

fn get_string_from_dict(dict: &core_foundation::dictionary::CFDictionary<core_foundation::string::CFString, *const std::ffi::c_void>, key: &str) -> Option<String> {
    use core_foundation::string::CFString;
    use core_foundation::base::TCFType;

    let cf_key = CFString::new(key);
    unsafe {
        if let Some(value) = dict.find(cf_key) {
            let cf_str: CFString = CFString::wrap_under_get_rule(*value as *const _);
            Some(cf_str.to_string())
        } else {
            None
        }
    }
}

fn get_number_from_dict(dict: &core_foundation::dictionary::CFDictionary<core_foundation::string::CFString, *const std::ffi::c_void>, key: &str) -> Option<i64> {
    use core_foundation::string::CFString;
    use core_foundation::number::CFNumber;
    use core_foundation::base::TCFType;

    let cf_key = CFString::new(key);
    unsafe {
        if let Some(value) = dict.find(cf_key) {
            let cf_num: CFNumber = CFNumber::wrap_under_get_rule(*value as *const _);
            cf_num.to_i64()
        } else {
            None
        }
    }
}

fn get_bounds_from_dict(dict: &core_foundation::dictionary::CFDictionary<core_foundation::string::CFString, *const std::ffi::c_void>) -> (f64, f64, f64, f64) {
    use core_foundation::string::CFString;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::base::TCFType;

    let cf_key = CFString::new("kCGWindowBounds");
    unsafe {
        if let Some(bounds_ref) = dict.find(cf_key) {
            let bounds_dict: CFDictionary<CFString, *const std::ffi::c_void> =
                CFDictionary::wrap_under_get_rule(*bounds_ref as *const _);

            let x = get_number_from_dict(&bounds_dict, "X").unwrap_or(0) as f64;
            let y = get_number_from_dict(&bounds_dict, "Y").unwrap_or(0) as f64;
            let width = get_number_from_dict(&bounds_dict, "Width").unwrap_or(0) as f64;
            let height = get_number_from_dict(&bounds_dict, "Height").unwrap_or(0) as f64;

            (x, y, width, height)
        } else {
            (0.0, 0.0, 0.0, 0.0)
        }
    }
}

/// Capture a window by its CGWindowID
fn capture_window_by_id(window_id: u32, bounds: (f64, f64, f64, f64)) -> Result<image::RgbaImage> {
    use foreign_types_shared::ForeignType;

    let (x, y, width, height) = bounds;

    let rect = CGRect {
        origin: CGPoint { x: x as CGFloat, y: y as CGFloat },
        size: CGSize { width: width as CGFloat, height: height as CGFloat },
    };

    unsafe {
        // kCGWindowListOptionIncludingWindow renders the backing store of *this*
        // window_id specifically. kCGWindowListOptionAll would ignore window_id and
        // composite every window intersecting `rect`, which captures whatever is in
        // that screen region on the active Space when the target window lives on
        // another Space.
        let image_ref = CGWindowListCreateImage(
            rect,
            kCGWindowListOptionIncludingWindow,
            window_id,
            kCGWindowImageDefault | kCGWindowImageBoundsIgnoreFraming,
        );

        if image_ref.is_null() {
            return Err(Error::WindowOperationFailed("Failed to capture window image".to_string()));
        }

        let cg_image = core_graphics::image::CGImage::from_ptr(image_ref);

        let img_width = cg_image.width();
        let img_height = cg_image.height();
        let bytes_per_row = cg_image.bytes_per_row();
        let data = cg_image.data();

        // Convert CGImage data to RgbaImage
        // CGImage data is typically BGRA
        let data_slice = data.bytes();
        let data_len = data_slice.len();
        let mut rgba_data = Vec::with_capacity(img_width * img_height * 4);

        for row in 0..img_height {
            for col in 0..img_width {
                let offset = row * bytes_per_row + col * 4;
                if offset + 3 < data_len {
                    let b = data_slice[offset];
                    let g = data_slice[offset + 1];
                    let r = data_slice[offset + 2];
                    let a = data_slice[offset + 3];
                    rgba_data.push(r);
                    rgba_data.push(g);
                    rgba_data.push(b);
                    rgba_data.push(a);
                }
            }
        }

        image::RgbaImage::from_raw(img_width as u32, img_height as u32, rgba_data)
            .ok_or_else(|| Error::WindowOperationFailed("Failed to create image from raw data".to_string()))
    }
}

// macOS-specific implementation for taking screenshots
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

        // Preferred path: capture *our own* window deterministically by its
        // CoreGraphics window ID. The plugin runs inside the Tauri app process,
        // so any window owned by our PID is unambiguously ours. This is immune to
        // title ambiguity (overlay / hidden-title / transparent windows report an
        // empty CG title) and works even when the window is on another Space,
        // where xcap's title-based matching silently captures the wrong window.
        let own_pid = std::process::id() as i32;
        let cg_windows = get_all_windows_cg();
        let own_windows: Vec<&WindowInfo> = cg_windows
            .iter()
            .filter(|w| w.owner_pid == own_pid && w.layer == 0 && w.bounds.2 > 100.0 && w.bounds.3 > 100.0)
            .collect();
        if !own_windows.is_empty() {
            // Prefer an exact title match (disambiguates multi-window apps);
            // otherwise the largest own window (single-window apps, including
            // empty-title overlay windows).
            let target = own_windows
                .iter()
                .find(|w| !window_title.is_empty() && w.name == window_title)
                .copied()
                .or_else(|| {
                    own_windows.iter().copied().max_by(|a, b| {
                        (a.bounds.2 * a.bounds.3)
                            .partial_cmp(&(b.bounds.2 * b.bounds.3))
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                });
            if let Some(window_info) = target {
                info!(
                    "[TAURI-MCP] Capturing own window by PID match: id={}, name='{}', pid={}",
                    window_info.window_id, window_info.name, window_info.owner_pid
                );
                let image = capture_window_by_id(window_info.window_id, window_info.bounds)?;
                info!("[TAURI-MCP] Successfully captured window image: {}x{}", image.width(), image.height());
                let dynamic_image = image::DynamicImage::ImageRgba8(image);
                return finalize_screenshot(dynamic_image, &params_clone);
            }
        }

        // First try xcap (works for most windows)
        let xcap_windows = xcap::Window::all().unwrap_or_default();
        info!("[TAURI-MCP] Found {} windows through xcap", xcap_windows.len());

        // Try to find window using xcap first
        if let Some(window) = find_window(&xcap_windows, &window_title, &application_name) {
            info!("[TAURI-MCP] Found window via xcap, capturing...");
            let image = match window.capture_image() {
                Ok(img) => img,
                Err(e) => return Err(Error::WindowOperationFailed(format!("Failed to capture window image: {}", e))),
            };

            info!("[TAURI-MCP] Successfully captured window image: {}x{}",
                  image.width(), image.height());

            let dynamic_image = image::DynamicImage::ImageRgba8(image);
            return finalize_screenshot(dynamic_image, &params_clone);
        }

        // xcap didn't find it - try using CGWindowListCopyWindowInfo with kCGWindowListOptionAll
        // This finds Tauri windows that xcap misses
        info!("[TAURI-MCP] xcap didn't find window, trying CGWindowListCopyWindowInfo with kCGWindowListOptionAll...");

        let cg_windows = get_all_windows_cg();
        info!("[TAURI-MCP] Found {} windows through CGWindowListCopyWindowInfo", cg_windows.len());

        // Find the target window in the CG list
        if let Some(window_info) = find_window_cg(&cg_windows, &window_title, &application_name) {
            info!("[TAURI-MCP] Found window via CG: id={}, name='{}', owner='{}'",
                  window_info.window_id, window_info.name, window_info.owner_name);

            // Capture using CGWindowListCreateImage
            let image = capture_window_by_id(window_info.window_id, window_info.bounds)?;

            info!("[TAURI-MCP] Successfully captured window image: {}x{}",
                  image.width(), image.height());

            let dynamic_image = image::DynamicImage::ImageRgba8(image);
            return finalize_screenshot(dynamic_image, &params_clone);
        }

        // Check if it's a permissions issue
        let only_menubar = xcap_windows.len() <= 1 && xcap_windows.iter().all(|w|
            w.app_name().unwrap_or_default() == "Window Server" || w.title().unwrap_or_default() == "Menubar"
        );

        if only_menubar {
            Err(Error::WindowOperationFailed(
                "Screen Recording permission required. Please grant permission in: \
                System Preferences > Privacy & Security > Screen Recording, \
                then restart the app.".to_string()
            ))
        } else {
            Err(Error::WindowOperationFailed(
                format!("Window not found. Searched for title='{}', app='{}'. \
                Found {} xcap windows and {} CG windows.",
                window_title, application_name, xcap_windows.len(), cg_windows.len())
            ))
        }
    }).await
}

// Helper function to find the window in the xcap window list.
// Delegates the matching ladder to the shared cross-platform helper.
fn find_window(xcap_windows: &[xcap::Window], window_title: &str, application_name: &str) -> Option<xcap::Window> {
    // Check if we might have a permissions issue (only Window Server menubar visible)
    if xcap_windows.len() <= 1 {
        let only_menubar = xcap_windows.iter().all(|w|
            w.app_name().unwrap_or_default() == "Window Server" || w.title().unwrap_or_default() == "Menubar"
        );
        if only_menubar {
            error!("[TAURI-MCP] Permission issue detected: Only Window Server menubar is visible.");
            error!("[TAURI-MCP] Please grant Screen Recording permission to this app in:");
            error!("[TAURI-MCP] System Preferences > Privacy & Security > Screen Recording");
        }
    }

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

// Helper function to find window in CGWindowListCopyWindowInfo results
fn find_window_cg(windows: &[WindowInfo], window_title: &str, application_name: &str) -> Option<WindowInfo> {
    let application_name_lower = application_name.to_lowercase();
    let window_title_lower = window_title.to_lowercase();

    // Only consider layer 0 windows (normal windows)
    let normal_windows: Vec<_> = windows.iter()
        .filter(|w| w.layer == 0)
        .collect();

    info!("[TAURI-MCP] CG: Searching {} normal windows for title='{}', app='{}'",
          normal_windows.len(), window_title, application_name);

    // Step 1: Exact owner name + window name match
    for window in &normal_windows {
        if window.owner_name.to_lowercase() == application_name_lower
            && window.name == window_title {
            return Some((*window).clone());
        }
    }

    // Step 2: Owner name contains app name + exact window name
    for window in &normal_windows {
        if window.owner_name.to_lowercase().contains(&application_name_lower)
            && window.name == window_title {
            return Some((*window).clone());
        }
    }

    // Step 3: Owner name match + partial window name match
    for window in &normal_windows {
        if window.owner_name.to_lowercase().contains(&application_name_lower)
            && window.name.to_lowercase().contains(&window_title_lower) {
            return Some((*window).clone());
        }
    }

    // Step 4: Just partial window name match with non-empty name
    for window in &normal_windows {
        if !window.name.is_empty()
            && window.name.to_lowercase().contains(&window_title_lower) {
            return Some((*window).clone());
        }
    }

    // Step 5: Owner name match only (for windows with empty title)
    for window in &normal_windows {
        if window.owner_name.to_lowercase() == application_name_lower
            && window.bounds.2 > 100.0 && window.bounds.3 > 100.0 { // reasonable size
            return Some((*window).clone());
        }
    }

    None
}

// Add any other macOS-specific functionality here
