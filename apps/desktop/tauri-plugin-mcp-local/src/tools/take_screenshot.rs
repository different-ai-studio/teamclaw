use crate::error::{Error, Result};
use crate::shared::ScreenshotParams;
use base64::Engine;
use image::DynamicImage;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use log::info;
use crate::TauriMcpExt;
use crate::models::ScreenshotRequest;
use crate::socket_server::SocketResponse;

/// Encode an image as JPEG at the given quality. JPEG has no alpha channel
/// and image 0.25's encoder rejects RGBA input, so convert to RGB first.
fn encode_jpeg(image: &DynamicImage, quality: u8, out: &mut Vec<u8>) -> Result<()> {
    out.clear();
    let rgb = image.to_rgb8();
    let mut cursor = std::io::Cursor::new(out);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
    rgb.write_with_encoder(encoder)
        .map_err(|e| Error::WindowOperationFailed(format!("Failed to encode JPEG: {}", e)))
}

/// Resize and compress a DynamicImage to JPEG bytes based on params.
/// Returns (jpeg_bytes, final_width, final_height).
pub fn process_image_to_bytes(
    mut dynamic_image: DynamicImage,
    quality: u8,
    max_width_override: Option<u32>,
    max_size_bytes: u64,
) -> Result<Vec<u8>> {
    // Use max_width if specified, otherwise use a default if image is very large
    let effective_max_width = max_width_override.unwrap_or_else(|| {
        if dynamic_image.width() > 1024 {
            info!("[SCREENSHOT] No max width specified, defaulting to 1024px");
            1024
        } else {
            dynamic_image.width()
        }
    });

    // Handle resizing if the image is too large
    if dynamic_image.width() > effective_max_width {
        info!(
            "[SCREENSHOT] Resizing from {}x{} to maintain max width of {}",
            dynamic_image.width(),
            dynamic_image.height(),
            effective_max_width
        );
        let height = (dynamic_image.height() as f32
            * (effective_max_width as f32 / dynamic_image.width() as f32))
            as u32;
        dynamic_image = dynamic_image.resize(
            effective_max_width,
            height,
            image::imageops::FilterType::Triangle,
        );
    }

    let mut output_data = Vec::new();
    let mut current_quality = quality;

    // Try encoding with JPEG
    encode_jpeg(&dynamic_image, current_quality, &mut output_data)?;

    // Reduce quality if needed to meet max size
    while output_data.len() as u64 > max_size_bytes && current_quality > 30 {
        info!(
            "[SCREENSHOT] Output size {} bytes exceeds max {}. Reducing quality to {}",
            output_data.len(),
            max_size_bytes,
            current_quality - 10
        );
        current_quality -= 10;
        encode_jpeg(&dynamic_image, current_quality, &mut output_data)?;
    }

    // If still too large, resize the image
    if output_data.len() as u64 > max_size_bytes && dynamic_image.width() > 800 {
        info!("[SCREENSHOT] Image still too large after quality reduction. Resizing...");
        let scale_factor = 0.8;

        while output_data.len() as u64 > max_size_bytes && dynamic_image.width() > 800 {
            let new_width = (dynamic_image.width() as f32 * scale_factor) as u32;
            let new_height = (dynamic_image.height() as f32 * scale_factor) as u32;
            info!("[SCREENSHOT] Resizing to {}x{}", new_width, new_height);
            dynamic_image = dynamic_image.resize(
                new_width,
                new_height,
                image::imageops::FilterType::Triangle,
            );
            encode_jpeg(&dynamic_image, current_quality, &mut output_data)?;

            if dynamic_image.width() <= 800 {
                break;
            }
        }
    }

    info!(
        "[SCREENSHOT] Final image size: {}x{}, data size: {} bytes, quality: {}",
        dynamic_image.width(),
        dynamic_image.height(),
        output_data.len(),
        current_quality
    );

    Ok(output_data)
}

/// Process image to base64 data URL. Thin wrapper around process_image_to_bytes.
pub fn process_image(dynamic_image: DynamicImage, params: &ScreenshotParams) -> Result<String> {
    let quality = params.quality.unwrap_or(70) as u8;
    let max_width = params.max_width.map(|w| w as u32);
    let max_size_bytes = params
        .max_size_mb
        .map(|mb| (mb * 1024.0 * 1024.0) as u64)
        .unwrap_or(1024 * 1024);

    let output_data = process_image_to_bytes(dynamic_image, quality, max_width, max_size_bytes)?;

    let base64_data = base64::engine::general_purpose::STANDARD.encode(&output_data);

    // Final check - reject if still too large
    if base64_data.len() > 3 * 1024 * 1024 {
        return Err(Error::WindowOperationFailed(format!(
            "Screenshot is still too large: {} bytes. Try using a smaller max_width.",
            base64_data.len()
        )));
    }

    Ok(format!("data:image/jpeg;base64,{}", base64_data))
}

/// Return the user's home directory, if it can be determined.
fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var).map(std::path::PathBuf::from)
}

/// Canonicalize a path that may not exist yet: canonicalize the deepest
/// existing ancestor and re-append the non-existing tail. This resolves
/// symlinked roots (e.g. /tmp -> /private/tmp on macOS) so containment
/// checks compare like with like.
fn canonicalize_lenient(path: &std::path::Path) -> std::path::PathBuf {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();

    while !existing.exists() {
        match existing.file_name() {
            Some(name) => {
                tail.push(name.to_os_string());
                if !existing.pop() {
                    break;
                }
            }
            None => break,
        }
    }

    let mut resolved = existing.canonicalize().unwrap_or(existing);
    for part in tail.iter().rev() {
        resolved.push(part);
    }
    resolved
}

/// Validate a caller-supplied screenshot output directory.
///
/// Rejects paths containing `..` components and requires the resolved path
/// to be inside either the system temp directory or the user's home
/// directory, preventing arbitrary filesystem writes.
pub fn validate_output_dir(output_dir: &str) -> Result<()> {
    use std::path::{Component, Path};

    let path = Path::new(output_dir);

    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Error::WindowOperationFailed(format!(
            "Invalid output_dir '{}': path must not contain '..' components",
            output_dir
        )));
    }

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| {
                Error::WindowOperationFailed(format!(
                    "Failed to resolve output_dir '{}': {}",
                    output_dir, e
                ))
            })?
            .join(path)
    };
    let resolved = canonicalize_lenient(&absolute);

    let mut allowed_roots = vec![canonicalize_lenient(&std::env::temp_dir())];
    if let Some(home) = home_dir() {
        allowed_roots.push(canonicalize_lenient(&home));
    }

    if allowed_roots.iter().any(|root| resolved.starts_with(root)) {
        Ok(())
    } else {
        Err(Error::WindowOperationFailed(format!(
            "Invalid output_dir '{}': must be inside the system temp directory or your home directory",
            output_dir
        )))
    }
}

/// Process image and write to a file on disk. Returns the file path.
pub fn process_image_to_file(
    dynamic_image: DynamicImage,
    params: &ScreenshotParams,
    output_dir: &str,
) -> Result<String> {
    validate_output_dir(output_dir)?;

    let quality = params.quality.unwrap_or(70) as u8;
    let max_width = params.max_width.map(|w| w as u32);
    let max_size_bytes = params
        .max_size_mb
        .map(|mb| (mb * 1024.0 * 1024.0) as u64)
        .unwrap_or(1024 * 1024);

    let output_data = process_image_to_bytes(dynamic_image, quality, max_width, max_size_bytes)?;

    // Ensure output directory exists
    std::fs::create_dir_all(output_dir).map_err(|e| {
        Error::WindowOperationFailed(format!("Failed to create output directory '{}': {}", output_dir, e))
    })?;

    // Generate timestamped filename
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file_path = format!("{}/screenshot_{}.jpg", output_dir, timestamp);

    std::fs::write(&file_path, &output_data).map_err(|e| {
        Error::WindowOperationFailed(format!("Failed to write screenshot to '{}': {}", file_path, e))
    })?;

    info!("[SCREENSHOT] Saved screenshot to: {} ({} bytes)", file_path, output_data.len());

    Ok(file_path)
}

/// Generate a small thumbnail as base64 data URL.
/// Uses hardcoded params: max_width=512, quality=50, max_size=300KB.
pub fn process_thumbnail(dynamic_image: DynamicImage) -> Result<String> {
    let output_data = process_image_to_bytes(
        dynamic_image,
        50,                    // quality
        Some(512),             // max_width
        300 * 1024,            // max_size: 300KB
    )?;

    let base64_data = base64::engine::general_purpose::STANDARD.encode(&output_data);
    Ok(format!("data:image/jpeg;base64,{}", base64_data))
}

pub async fn handle_take_screenshot<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse> {
    let payload: ScreenshotRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for takeScreenshot: {}", e)))?;

    // Reject unsafe output directories up front with a clear error
    if let Some(output_dir) = &payload.output_dir {
        if let Err(e) = validate_output_dir(output_dir) {
            return Ok(SocketResponse::err(None, e.to_string()));
        }
    }

    // A hidden window still captures — but as a blank frame. Detect it up
    // front so the response can warn instead of silently returning a blank
    // image the agent might misread as "the app rendered nothing".
    let window_label = payload.window_label.clone();
    let window_visible = app
        .webview_windows()
        .get(&window_label)
        .and_then(|w| w.is_visible().ok());

    // Call the async method
    let result = app.tauri_mcp().take_screenshot_async(payload).await;
    match result {
        Ok(response) => {
            let mut data = serde_json::to_value(response)
                .map_err(|e| Error::Anyhow(format!("Failed to serialize response: {}", e)))?;
            if window_visible == Some(false) {
                if let Some(obj) = data.as_object_mut() {
                    obj.insert("windowVisible".into(), serde_json::json!(false));
                    obj.insert(
                        "warning".into(),
                        serde_json::json!(format!(
                            "Window '{}' is not visible — the capture is likely blank. \
                             Show it first with manage_window(action='show', window_label='{}').",
                            window_label, window_label
                        )),
                    );
                }
            }
            Ok(SocketResponse::ok(None, Some(data)))
        }
        Err(e) => Ok(SocketResponse::err(None, e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_jpeg_accepts_rgba_input() {
        // image 0.25's JPEG encoder rejects RGBA; encode_jpeg must convert.
        let rgba = image::RgbaImage::from_pixel(64, 48, image::Rgba([200, 100, 50, 255]));
        let img = DynamicImage::ImageRgba8(rgba);

        let bytes = process_image_to_bytes(img, 70, None, 1024 * 1024).unwrap();
        assert!(!bytes.is_empty());
        // JPEG SOI marker
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    }
}
