use crate::error::{Error, Result};
use crate::shared::ScreenshotParams;
use base64;
use image::DynamicImage;
use serde_json::Value;
use tauri::{AppHandle, Runtime};
use log::info;
use crate::TauriMcpExt;
use crate::models::ScreenshotRequest;
use crate::socket_server::SocketResponse;

/// Common function to process and compress an image - used by platform implementations
pub fn process_image(mut dynamic_image: DynamicImage, params: &ScreenshotParams) -> Result<String> {
    // Extract parameters from the shared struct
    let quality = params.quality.unwrap_or(85) as u8;
    let max_width = params.max_width.map(|w| w as u32);
    let max_size_bytes = params
        .max_size_mb
        .map(|mb| (mb * 1024.0 * 1024.0) as u64)
        .unwrap_or(2 * 1024 * 1024);

    // Use max_width if specified, otherwise use a default if image is very large
    let effective_max_width = max_width.unwrap_or_else(|| {
        if dynamic_image.width() > 1920 {
            info!("[SCREENSHOT] No max width specified, defaulting to 1920px");
            1920
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
        // Maintain aspect ratio
        let height = (dynamic_image.height() as f32
            * (effective_max_width as f32 / dynamic_image.width() as f32))
            as u32;
        dynamic_image = dynamic_image.resize(
            effective_max_width,
            height,
            image::imageops::FilterType::Triangle,
        );
    }

    // Use JPG for better compression
    let mut output_data = Vec::new();
    let mut current_quality = quality;

    // Try encoding with JPEG
    match dynamic_image.write_to(
        &mut std::io::Cursor::new(&mut output_data),
        image::ImageOutputFormat::Jpeg(current_quality),
    ) {
        Ok(_) => {
            // Reduce quality if needed to meet max size
            while output_data.len() as u64 > max_size_bytes && current_quality > 30 {
                info!(
                    "[SCREENSHOT] Output size {} bytes exceeds max {}. Reducing quality to {}",
                    output_data.len(),
                    max_size_bytes,
                    current_quality - 10
                );

                // Reduce quality and try again
                current_quality -= 10;
                output_data.clear();

                if let Err(e) = dynamic_image.write_to(
                    &mut std::io::Cursor::new(&mut output_data),
                    image::ImageOutputFormat::Jpeg(current_quality),
                ) {
                    return Err(Error::window_operation_failed(
                        "image encoding",
                        format!("Failed to re-encode JPEG: {}", e),
                    ));
                }
            }

            // If still too large, resize the image
            if output_data.len() as u64 > max_size_bytes && dynamic_image.width() > 800 {
                info!("[SCREENSHOT] Image still too large after quality reduction. Resizing...");
                let scale_factor = 0.8; // reduce by 20% each iteration

                while output_data.len() as u64 > max_size_bytes && dynamic_image.width() > 800 {
                    // Resize image
                    let new_width = (dynamic_image.width() as f32 * scale_factor) as u32;
                    let new_height = (dynamic_image.height() as f32 * scale_factor) as u32;

                    info!("[SCREENSHOT] Resizing to {}x{}", new_width, new_height);
                    dynamic_image = dynamic_image.resize(
                        new_width,
                        new_height,
                        image::imageops::FilterType::Triangle,
                    );

                    // Re-encode with current quality
                    output_data.clear();
                    if let Err(e) = dynamic_image.write_to(
                        &mut std::io::Cursor::new(&mut output_data),
                        image::ImageOutputFormat::Jpeg(current_quality),
                    ) {
                        return Err(Error::window_operation_failed(
                            "image resizing",
                            format!("Failed to encode resized image: {}", e),
                        ));
                    }

                    // Give up if we're getting very small
                    if dynamic_image.width() <= 800 {
                        break;
                    }
                }
            }

            // Convert to base64
            let base64_data = base64::encode(&output_data);
            let data_url = format!("data:image/jpeg;base64,{}", base64_data);

            info!(
                "[SCREENSHOT] Final image size: {}x{}, data size: {} bytes, quality: {}",
                dynamic_image.width(),
                dynamic_image.height(),
                output_data.len(),
                current_quality
            );

            // Final check - reject if still too large
            if base64_data.len() > 5 * 1024 * 1024 {
                return Err(Error::window_operation_failed(
                    "screenshot compression",
                    format!(
                        "Screenshot is still too large: {} bytes. Try using a smaller max_width.",
                        base64_data.len()
                    ),
                ));
            }

            Ok(data_url)
        }
        Err(e) => Err(Error::window_operation_failed(
            "JPEG encoding",
            format!("Failed to encode JPEG: {}", e),
        )),
    }
}

pub async fn handle_take_screenshot<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse> {
    let payload: ScreenshotRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow { message: format!("Invalid payload for takeScreenshot: {}", e) })?;

    // Call the async method
    let result = app.tauri_mcp().take_screenshot_async(payload).await;
    match result {
        Ok(response) => {
            let data = serde_json::to_value(response)
                .map_err(|e| Error::Anyhow { message: format!("Failed to serialize response: {}", e) })?;
            Ok(SocketResponse {
                success: true,
                data: Some(data),
                error: None,
            })
        }
        Err(e) => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(e.to_string()),
        }),
    }
}
