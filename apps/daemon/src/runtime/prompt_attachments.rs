//! Resolve session attachment URLs into runtime-ready payloads.
//!
//! Cloud clients upload images to Supabase and pass HTTPS URLs in
//! `attachment_urls`. opencode serve requires image `File` parts to use
//! `data:` URLs; pi/claude/cursor backends also need inline data URLs rather
//! than bare storage links. This module downloads, optionally downscales
//! (#710), and formats attachments for all runtimes.

use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine as _;
use tracing::warn;

static IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];

/// Longest edge cap for images inlined into prompts.
const PROMPT_IMAGE_MAX_DIMENSION: u32 = 2048;
/// Images at or below this byte size are inlined as-is.
const PROMPT_IMAGE_SKIP_BELOW_BYTES: usize = 512 * 1024;

/// A storage URL resolved for prompt delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedAttachment {
    /// Image bytes encoded as `data:{mime};base64,...`.
    Image {
        data_url: String,
        mime: String,
        filename: Option<String>,
    },
    /// Non-image file referenced by its original HTTPS URL.
    Link {
        url: String,
        filename: String,
        mime: String,
    },
}

/// Return the (path-without-query, extension) for a URL.
pub fn path_and_ext(url: &str) -> (&str, String) {
    let path = url.split('?').next().unwrap_or(url);
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    (path, ext)
}

pub fn mime_from_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn filename_from_path(path: &str) -> String {
    path.rsplit('/').next().unwrap_or("attachment").to_string()
}

pub fn format_data_url(mime: &str, bytes: &[u8]) -> String {
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{data}")
}

fn attachment_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("attachment reqwest client")
    })
}

/// True when the URL path looks like an image we must inline as a data URL.
pub fn is_image_attachment_url(url: &str) -> bool {
    IMAGE_EXTS.contains(&path_and_ext(url).1.as_str())
}

/// Download and resolve attachment URLs. On fetch/decode failure, falls back
/// to the original HTTPS link so text backends still see the reference; opencode
/// skips failed image fallbacks (HTTPS images are rejected by serve).
pub async fn resolve_all(urls: &[String]) -> Vec<ResolvedAttachment> {
    let mut out = Vec::with_capacity(urls.len());
    for url in urls {
        match resolve_one(url).await {
            Ok(resolved) => out.push(resolved),
            Err(err) => {
                warn!(url = %url, err = %err, "attachment fetch failed; using remote link fallback");
                let (path, ext) = path_and_ext(url);
                out.push(ResolvedAttachment::Link {
                    url: url.clone(),
                    filename: filename_from_path(path),
                    mime: mime_from_ext(&ext).to_string(),
                });
            }
        }
    }
    out
}

async fn resolve_one(url: &str) -> anyhow::Result<ResolvedAttachment> {
    if url.starts_with("data:") {
        let mime = url
            .strip_prefix("data:")
            .and_then(|rest| rest.split(';').next())
            .unwrap_or("application/octet-stream")
            .to_string();
        return Ok(ResolvedAttachment::Image {
            data_url: url.to_string(),
            mime,
            filename: None,
        });
    }

    let (path, ext) = path_and_ext(url);
    if IMAGE_EXTS.contains(&ext.as_str()) {
        let bytes = attachment_client()
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?
            .to_vec();
        let mime = mime_from_ext(&ext);
        let (bytes, mime) = compress_image_for_prompt(bytes, mime).await;
        let data_url = format_data_url(mime, &bytes);
        return Ok(ResolvedAttachment::Image {
            data_url,
            mime: mime.to_string(),
            filename: Some(filename_from_path(path)),
        });
    }

    Ok(ResolvedAttachment::Link {
        url: url.to_string(),
        filename: filename_from_path(path),
        mime: mime_from_ext(&ext).to_string(),
    })
}

async fn compress_image_for_prompt(bytes: Vec<u8>, mime: &'static str) -> (Vec<u8>, &'static str) {
    if mime == "image/gif" || bytes.len() <= PROMPT_IMAGE_SKIP_BELOW_BYTES {
        return (bytes, mime);
    }
    let original_len = bytes.len();
    let input = bytes.clone();
    let compressed = tokio::task::spawn_blocking(move || -> Option<Vec<u8>> {
        let img = match image::load_from_memory(&input) {
            Ok(img) => img,
            Err(err) => {
                tracing::warn!("attachment image decode failed, inlining original: {err}");
                return None;
            }
        };
        let img = if img.width().max(img.height()) > PROMPT_IMAGE_MAX_DIMENSION {
            img.resize(
                PROMPT_IMAGE_MAX_DIMENSION,
                PROMPT_IMAGE_MAX_DIMENSION,
                image::imageops::FilterType::Triangle,
            )
        } else {
            img
        };
        let mut out = std::io::Cursor::new(Vec::new());
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
        if let Err(err) = img.to_rgb8().write_with_encoder(encoder) {
            tracing::warn!("attachment image re-encode failed, inlining original: {err}");
            return None;
        }
        let encoded = out.into_inner();
        (encoded.len() < original_len).then_some(encoded)
    })
    .await;
    match compressed {
        Ok(Some(encoded)) => (encoded, "image/jpeg"),
        Ok(None) => (bytes, mime),
        Err(err) => {
            tracing::warn!("attachment image compression task failed: {err}");
            (bytes, mime)
        }
    }
}

impl ResolvedAttachment {
    pub fn opencode_file_fields(&self) -> (String, String, Option<String>) {
        match self {
            ResolvedAttachment::Image {
                data_url,
                mime,
                filename,
            } => (mime.clone(), data_url.clone(), filename.clone()),
            ResolvedAttachment::Link {
                url,
                filename,
                mime,
            } => (mime.clone(), url.clone(), Some(filename.clone())),
        }
    }
}

/// Append resolved attachments to a text prompt (pi / claude-code / cursor).
pub fn append_to_message(message: &mut String, attachments: &[ResolvedAttachment]) {
    if attachments.is_empty() {
        return;
    }
    message.push_str("\n\nAttachments:\n");
    for att in attachments {
        match att {
            ResolvedAttachment::Image { data_url, filename, .. } => {
                if let Some(name) = filename {
                    message.push_str(name);
                    message.push_str(": ");
                }
                message.push_str(data_url);
                message.push('\n');
            }
            ResolvedAttachment::Link { url, filename, .. } => {
                message.push_str(filename);
                message.push_str(": ");
                message.push_str(url);
                message.push('\n');
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_and_ext_strips_query_before_extension() {
        let url = "https://x.supabase.co/storage/v1/object/public/attachments/t/s/abc/photo.png?token=eyJ.foo.bar";
        let (path, ext) = path_and_ext(url);
        assert!(path.ends_with("photo.png"));
        assert_eq!(ext, "png");
    }

    #[test]
    fn format_data_url_prefix() {
        let url = format_data_url("image/png", b"\x89PNG");
        assert!(url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn mime_from_ext_maps_common_images() {
        assert_eq!(mime_from_ext("jpeg"), "image/jpeg");
        assert_eq!(mime_from_ext("webp"), "image/webp");
        assert_eq!(mime_from_ext("pdf"), "application/pdf");
    }

    #[test]
    fn is_image_attachment_url_strips_query() {
        let url = "https://x/y/photo.png?token=eyJ.foo.bar";
        assert!(is_image_attachment_url(url));
        assert!(!is_image_attachment_url("https://x/y/doc.pdf"));
    }

    #[test]
    fn append_to_message_inlines_image_data_url() {
        let mut message = String::from("hello");
        append_to_message(
            &mut message,
            &[ResolvedAttachment::Image {
                data_url: "data:image/png;base64,abc".into(),
                mime: "image/png".into(),
                filename: Some("shot.png".into()),
            }],
        );
        assert!(message.contains("Attachments:"));
        assert!(message.contains("shot.png:"));
        assert!(message.contains("data:image/png;base64,abc"));
    }
}
