use anyhow::{Context, Result};
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageEncoder};
use std::io::Cursor;
use xcap::Monitor;

/// Information about a captured screenshot.
pub struct ScreenCapture {
    /// The captured image (physical pixels).
    pub image: DynamicImage,
    /// Physical pixel width.
    pub phys_w: u32,
    /// Physical pixel height.
    pub phys_h: u32,
    /// Logical screen width (for input events).
    pub logical_w: u32,
    /// Logical screen height (for input events).
    pub logical_h: u32,
    /// Retina / HiDPI scale factor (physical / logical).
    pub scale: f64,
}

/// Capture the primary monitor and return a [`ScreenCapture`].
pub fn capture_screen() -> Result<ScreenCapture> {
    let monitors = Monitor::all().context("Failed to enumerate monitors")?;
    let monitor = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| Monitor::all().ok()?.into_iter().next())
        .context("No monitor found")?;

    let scale = monitor.scale_factor().unwrap_or(1.0) as f64;
    let logical_w = monitor.width().unwrap_or(1920);
    let logical_h = monitor.height().unwrap_or(1080);

    let raw = monitor
        .capture_image()
        .context("Failed to capture screenshot")?;

    let phys_w = raw.width();
    let phys_h = raw.height();

    let image = DynamicImage::ImageRgba8(raw);

    tracing::debug!(
        phys_w,
        phys_h,
        logical_w,
        logical_h,
        scale,
        "Screenshot captured"
    );

    Ok(ScreenCapture {
        image,
        phys_w,
        phys_h,
        logical_w,
        logical_h,
        scale,
    })
}

/// Encode a [`DynamicImage`] to a base64 JPEG string, optionally capping the
/// largest dimension to `max_dim` pixels (aspect-ratio preserving).
///
/// Uses JPEG encoding (quality 90) for significantly smaller file sizes compared
/// to PNG (~90% reduction), while maintaining full resolution and high visual
/// quality suitable for VLM recognition.
pub fn encode_image_base64(img: &DynamicImage, max_dim: Option<u32>) -> Result<String> {
    let img = if let Some(max) = max_dim {
        let w = img.width();
        let h = img.height();
        if w > max || h > max {
            let ratio = (max as f64 / w as f64).min(max as f64 / h as f64);
            let nw = (w as f64 * ratio).round() as u32;
            let nh = (h as f64 * ratio).round() as u32;
            img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
        } else {
            img.clone()
        }
    } else {
        img.clone()
    };

    // Convert RGBA -> RGB (JPEG does not support alpha channel)
    let rgb = img.to_rgb8();

    let mut buf: Vec<u8> = Vec::new();
    let encoder = JpegEncoder::new_with_quality(Cursor::new(&mut buf), 90);
    encoder
        .write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .context("JPEG encode failed")?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    tracing::debug!(size_kb = buf.len() / 1024, "JPEG encoded (quality=90)");
    Ok(b64)
}
