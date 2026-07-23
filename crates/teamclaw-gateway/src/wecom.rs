use crate::i18n;
use crate::wecom_config::{WeComConfig, WeComGatewayStatus, WeComGatewayStatusResponse};
use base64::Engine as _;
use futures_util::stream::SplitSink;
#[allow(unused_imports)]
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::{mpsc, oneshot, RwLock};

use crate::{commands, AcpHandle, AttachmentRecord, ChannelStore};

/// Global reference to the active WeComGateway for proactive message sending.
static ACTIVE_GATEWAY: OnceLock<Arc<RwLock<Option<WeComGateway>>>> = OnceLock::new();

fn get_active_gateway_holder() -> &'static Arc<RwLock<Option<WeComGateway>>> {
    ACTIVE_GATEWAY.get_or_init(|| Arc::new(RwLock::new(None)))
}

/// Decrypt AES-256-CBC encrypted data from WeCom.
/// WeCom images/files are encrypted with a per-message aeskey.
/// Algorithm: AES-256-CBC, PKCS#7 padding (32-byte aligned), IV = first 16 bytes of key.
fn decrypt_wecom_media(encrypted: &[u8], aeskey_b64: &str) -> Result<Vec<u8>, String> {
    use aes::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};

    type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

    // Base64-decode the key (may need padding)
    let padded_key = if aeskey_b64.ends_with('=') {
        aeskey_b64.to_string()
    } else {
        format!("{}=", aeskey_b64)
    };
    let key = base64::engine::general_purpose::STANDARD
        .decode(&padded_key)
        .map_err(|e| format!("Failed to decode aeskey: {}", e))?;

    if key.len() != 32 {
        return Err(format!("AES key must be 32 bytes, got {}", key.len()));
    }

    // IV = first 16 bytes of the key
    let iv = &key[..16];

    // Decrypt
    let mut buf = encrypted.to_vec();
    let decryptor =
        Aes256CbcDec::new_from_slices(&key, iv).map_err(|e| format!("AES init failed: {}", e))?;
    let decrypted = decryptor
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| format!("AES decryption failed: {:?}", e))?;

    // Manual PKCS#7 unpadding (32-byte aligned, values 1-32)
    if decrypted.is_empty() {
        return Err("Decrypted data is empty".into());
    }
    let pad_byte = *decrypted.last().unwrap() as usize;
    if pad_byte == 0 || pad_byte > 32 || pad_byte > decrypted.len() {
        // No valid padding — return as-is
        return Ok(decrypted.to_vec());
    }
    // Verify all padding bytes match
    let start = decrypted.len() - pad_byte;
    if decrypted[start..].iter().all(|&b| b as usize == pad_byte) {
        Ok(decrypted[..start].to_vec())
    } else {
        Ok(decrypted.to_vec())
    }
}

/// Fetch an encrypted WeCom media URL, decrypt with the per-message aeskey,
/// and detect the MIME type. Returns `(plaintext_bytes, mime)`.
async fn download_and_decrypt_wecom_media(
    url: &str,
    aeskey_b64: &str,
    filename_hint: Option<&str>,
) -> Result<(Vec<u8>, String), String> {
    let client = crate::try_http_client_secs(30).map_err(|e| format!("client build: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("media GET: {e} ({e:?})"))?;
    if !resp.status().is_success() {
        return Err(format!("media GET failed: HTTP {}", resp.status()));
    }
    let encrypted = resp
        .bytes()
        .await
        .map_err(|e| format!("media body: {e}"))?
        .to_vec();
    let plaintext = if aeskey_b64.is_empty() {
        encrypted
    } else {
        decrypt_wecom_media(&encrypted, aeskey_b64)?
    };
    let mime = resolve_mime(&plaintext, filename_hint);
    Ok((plaintext, mime))
}

/// Compress an image to fit within max_bytes by resizing and re-encoding as JPEG.
#[allow(dead_code)]
fn compress_image(bytes: &[u8], max_bytes: usize) -> Result<Vec<u8>, String> {
    use image::ImageReader;
    use std::io::Cursor;

    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to guess image format: {}", e))?
        .decode()
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    // Try progressively smaller sizes until it fits
    let (orig_w, orig_h) = (img.width(), img.height());
    for scale_pct in &[100u32, 75, 50, 35, 25] {
        let w = orig_w * scale_pct / 100;
        let h = orig_h * scale_pct / 100;
        let resized = if *scale_pct < 100 {
            img.resize(w, h, image::imageops::FilterType::Lanczos3)
        } else {
            img.clone()
        };

        // Encode as JPEG with quality 80
        let mut buf = Cursor::new(Vec::new());
        resized
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .map_err(|e| format!("JPEG encode failed: {}", e))?;

        let result = buf.into_inner();
        if result.len() <= max_bytes {
            return Ok(result);
        }
    }

    Err("Could not compress image small enough".into())
}

/// Detect MIME type from file magic bytes.
///
/// For ZIP-based files, attempts to distinguish OOXML subtypes (xlsx/docx/pptx)
/// by inspecting the ZIP directory entries. Falls back to `application/zip` if
/// the content cannot be identified as OOXML.
fn detect_mime_from_magic(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 4 {
        return None;
    }
    // Images
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg".into())
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some("image/png".into())
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif".into())
    } else if bytes.starts_with(b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WEBP" {
        Some("image/webp".into())
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp".into())
    // Documents
    } else if bytes.starts_with(b"%PDF") {
        Some("application/pdf".into())
    // ZIP archive — local file header (\x03\x04), empty archive (\x05\x06),
    // or spanned archive (\x07\x08). All OOXML files (xlsx/docx/pptx) start
    // with the local file header form.
    } else if bytes.starts_with(&[0x50, 0x4B, 0x03, 0x04])
        || bytes.starts_with(&[0x50, 0x4B, 0x05, 0x06])
        || bytes.starts_with(&[0x50, 0x4B, 0x07, 0x08])
    {
        // Try to identify OOXML subtypes by peeking at ZIP entry names.
        // OOXML packages always contain well-known directory prefixes.
        Some(detect_ooxml_from_zip(bytes).unwrap_or_else(|| "application/zip".into()))
    // Compound File Binary Format (legacy MS Office: .xls / .doc / .ppt)
    } else if bytes.len() >= 8 && bytes[..8] == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] {
        Some("application/x-cfb".into())
    } else {
        None
    }
}

/// Attempt to identify OOXML subtype by scanning ZIP local file header entries.
///
/// Instead of pulling in the full `zip` crate, we do a lightweight scan of the
/// ZIP local file headers (signature 0x50 0x4B 0x03 0x04) and inspect the
/// stored file names for well-known OOXML directory prefixes:
///   - `xl/`   → xlsx (Excel)
///   - `word/` → docx (Word)
///   - `ppt/`  → pptx (PowerPoint)
///   - `[Content_Types].xml` → confirms OOXML but subtype unknown
///
/// Returns `Some(mime)` if an OOXML subtype is identified, `None` otherwise
/// (caller should fall back to `application/zip`).
fn detect_ooxml_from_zip(bytes: &[u8]) -> Option<String> {
    // ZIP local file header structure:
    //   offset 0:  signature (4 bytes) = PK\x03\x04
    //   offset 26: filename length (2 bytes, little-endian)
    //   offset 28: extra field length (2 bytes, little-endian)
    //   offset 30: filename (variable length)
    //   followed by: extra field, then file data (or not, for stored entries)
    //
    // We scan up to 20 entries or 64KB (whichever comes first) to keep this fast.
    let limit = bytes.len().min(65536);
    let mut offset = 0;
    let mut entries_scanned = 0;
    let max_entries = 20;

    let mut has_content_types = false;

    while offset + 30 <= limit && entries_scanned < max_entries {
        // Check for local file header signature
        if bytes[offset..offset + 4] != [0x50, 0x4B, 0x03, 0x04] {
            break;
        }

        let fname_len = u16::from_le_bytes([bytes[offset + 26], bytes[offset + 27]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[offset + 28], bytes[offset + 29]]) as usize;
        let compressed_size = u32::from_le_bytes([
            bytes[offset + 18],
            bytes[offset + 19],
            bytes[offset + 20],
            bytes[offset + 21],
        ]) as usize;

        if offset + 30 + fname_len > limit {
            break;
        }

        let fname_bytes = &bytes[offset + 30..offset + 30 + fname_len];
        if let Ok(fname) = std::str::from_utf8(fname_bytes) {
            let fname_lower = fname.to_ascii_lowercase();
            if fname_lower.starts_with("xl/") || fname_lower == "xl" {
                return Some(
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into(),
                );
            }
            if fname_lower.starts_with("word/") || fname_lower == "word" {
                return Some(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        .into(),
                );
            }
            if fname_lower.starts_with("ppt/") || fname_lower == "ppt" {
                return Some(
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                        .into(),
                );
            }
            if fname_lower == "[content_types].xml" {
                has_content_types = true;
            }
        }

        // Advance to next entry: header(30) + filename + extra + compressed data
        offset += 30 + fname_len + extra_len + compressed_size;
        entries_scanned += 1;
    }

    // If we found [Content_Types].xml but no specific prefix, it's still likely
    // OOXML — return xlsx as the most common case (better than zip).
    if has_content_types {
        return Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into());
    }

    None
}

/// Extract filename from a Content-Disposition header value.
///
/// Handles both `filename="name.ext"` and `filename*=UTF-8''encoded` forms.
/// Returns `None` if no filename can be extracted.
#[allow(dead_code)]
fn extract_filename_from_content_disposition(header: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();

    // Try filename*= (RFC 5987 / RFC 6266) first — it supports UTF-8
    if let Some(pos) = lower.find("filename*=") {
        let after = &header[pos + "filename*=".len()..];
        // Format: charset'language'value (e.g. UTF-8''%E6%8A%A5%E8%A1%A8.xlsx)
        if let Some(tick_pos) = after.find("''") {
            let encoded = after[tick_pos + 2..]
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches('"');
            if !encoded.is_empty() {
                // URL-decode the filename
                if let Ok(decoded) = urlencoding::decode(encoded) {
                    let name = decoded.into_owned();
                    if !name.is_empty() {
                        return Some(name);
                    }
                }
            }
        }
    }

    // Fall back to plain filename= parameter.
    // Note: "filename*=" does NOT contain "filename=" as a substring
    // (the * comes before =), so a simple find is safe.
    if let Some(pos) = lower.find("filename=") {
        let after = &header[pos + "filename=".len()..];
        let name = if let Some(stripped) = after.strip_prefix('"') {
            // Quoted string
            stripped.split('"').next().unwrap_or("").to_string()
        } else {
            after.split(';').next().unwrap_or("").trim().to_string()
        };
        if !name.is_empty() {
            return Some(name);
        }
    }

    None
}

/// Decide the MIME type for a downloaded media payload.
///
/// Tries the filename hint first because it can distinguish OOXML subtypes
/// (xlsx vs docx vs pptx) that share identical ZIP magic bytes. Falls back
/// to magic-byte detection, then to `application/octet-stream` — never to
/// `image/png`, which previously caused Excel files to be saved as `.png`.
/// Format a byte count as a short human-readable size (e.g. "332 KB").
fn human_readable_size(bytes: usize) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[unit])
    } else {
        format!("{:.1} {}", size, UNITS[unit])
    }
}

fn resolve_mime(bytes: &[u8], filename_hint: Option<&str>) -> String {
    filename_hint
        .and_then(detect_mime_from_filename)
        .or_else(|| detect_mime_from_magic(bytes))
        .unwrap_or_else(|| "application/octet-stream".into())
}

/// File extension (without dot) for a known MIME type. Returns `bin` for
/// unknown types so saved filenames don't end in something like `.sheet`.
fn mime_to_ext(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        "application/msword" => "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "text/csv" => "csv",
        "text/plain" => "txt",
        "application/json" => "json",
        "application/xml" => "xml",
        "text/html" => "html",
        "text/markdown" => "md",
        "application/zip" => "zip",
        _ => "bin",
    }
}

/// Extract the lowercase extension from a filename, rejecting dotfiles
/// (`.hidden`), trailing dots (`name.`), and non-alphanumeric extensions.
#[allow(dead_code)]
fn ext_from_filename(filename: &str) -> Option<String> {
    let (stem, ext) = filename.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    if !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Infer MIME type from filename extension
fn detect_mime_from_filename(filename: &str) -> Option<String> {
    let ext = filename.rsplit('.').next()?.to_lowercase();
    match ext.as_str() {
        // Images
        "jpg" | "jpeg" => Some("image/jpeg".into()),
        "png" => Some("image/png".into()),
        "gif" => Some("image/gif".into()),
        "webp" => Some("image/webp".into()),
        "bmp" => Some("image/bmp".into()),
        "svg" => Some("image/svg+xml".into()),
        // Documents
        "pdf" => Some("application/pdf".into()),
        "doc" => Some("application/msword".into()),
        "docx" => {
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document".into())
        }
        "xls" => Some("application/vnd.ms-excel".into()),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into()),
        "ppt" => Some("application/vnd.ms-powerpoint".into()),
        "pptx" => {
            Some("application/vnd.openxmlformats-officedocument.presentationml.presentation".into())
        }
        "csv" => Some("text/csv".into()),
        "txt" => Some("text/plain".into()),
        "json" => Some("application/json".into()),
        "xml" => Some("application/xml".into()),
        "html" | "htm" => Some("text/html".into()),
        "md" => Some("text/markdown".into()),
        "zip" => Some("application/zip".into()),
        _ => None,
    }
}

/// Get platform code for WeCom QR auth API
fn get_plat_code() -> u8 {
    #[cfg(target_os = "macos")]
    {
        1
    }
    #[cfg(target_os = "windows")]
    {
        2
    }
    #[cfg(target_os = "linux")]
    {
        3
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        0
    }
}

const WECOM_QR_GENERATE_URL: &str = "https://work.weixin.qq.com/ai/qc/generate";
const WECOM_QR_POLL_URL: &str = "https://work.weixin.qq.com/ai/qc/query_result";

/// Fetch a QR code for WeCom bot authorization
pub async fn fetch_wecom_qr_code() -> Result<super::wecom_config::WeComQrAuthStart, String> {
    use crate::wecom_config::{WeComQrAuthStart, WeComQrGenerateResponse};

    let url = format!(
        "{}?source=teamclaw&plat={}",
        WECOM_QR_GENERATE_URL,
        get_plat_code()
    );
    let client = crate::http_client_secs(30);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("QR generate request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("QR generate failed: HTTP {}", resp.status()));
    }

    let body: WeComQrGenerateResponse = resp
        .json()
        .await
        .map_err(|e| format!("QR generate parse failed: {}", e))?;

    let data = body.data.ok_or("QR generate response missing data")?;
    if data.scode.is_empty() || data.auth_url.is_empty() {
        return Err("QR generate response missing scode or auth_url".into());
    }

    Ok(WeComQrAuthStart {
        scode: data.scode,
        auth_url: data.auth_url,
    })
}

/// Poll WeCom QR code scan result
pub async fn poll_wecom_qr_result(
    scode: &str,
) -> Result<super::wecom_config::WeComQrAuthPollResult, String> {
    use crate::wecom_config::{WeComQrAuthPollResult, WeComQrPollResponse};

    let url = format!("{}?scode={}", WECOM_QR_POLL_URL, urlencoding::encode(scode));
    let client = crate::try_http_client_secs(10).map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("QR poll request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("QR poll failed: HTTP {}", resp.status()));
    }

    let body: WeComQrPollResponse = resp
        .json()
        .await
        .map_err(|e| format!("QR poll parse failed: {}", e))?;

    let data = match body.data {
        Some(d) => d,
        None => {
            return Ok(WeComQrAuthPollResult {
                status: "waiting".into(),
                bot_id: None,
                secret: None,
            });
        }
    };

    if data.status == "success" {
        let bot_info = data
            .bot_info
            .ok_or("QR poll success but missing bot_info")?;
        Ok(WeComQrAuthPollResult {
            status: "success".into(),
            bot_id: Some(bot_info.botid),
            secret: Some(bot_info.secret),
        })
    } else {
        Ok(WeComQrAuthPollResult {
            status: data.status,
            bot_id: None,
            secret: None,
        })
    }
}

type WsSink = Arc<
    tokio::sync::Mutex<
        SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            tokio_tungstenite::tungstenite::Message,
        >,
    >,
>;

pub const WECOM_WS_ENDPOINT: &str = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_INTERVAL_SECS: u64 = 30;
#[allow(dead_code)]
const HEARTBEAT_TIMEOUT_SECS: u64 = 6;
use crate::{ProcessedMessageTracker, MAX_PROCESSED_MESSAGES};

/// Pending WebSocket response channels, keyed by req_id.
/// Used for request–response patterns (e.g. media upload) over the multiplexed WS.
type PendingResponses =
    Arc<tokio::sync::Mutex<std::collections::HashMap<String, oneshot::Sender<serde_json::Value>>>>;

#[derive(Clone)]
pub struct WeComGateway {
    config: Arc<RwLock<WeComConfig>>,
    pub acp: Arc<dyn AcpHandle>,
    pub store: Arc<dyn ChannelStore>,
    pub team_id: String,
    pub primary_agent_actor_id: String,
    pub agent_owner_actor_ids: Vec<String>,
    workspace_path: String,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<WeComGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    processed_messages: Arc<RwLock<ProcessedMessageTracker>>,
    pending_questions: Arc<super::PendingQuestionStore>,
    shared_ws_sink: Arc<RwLock<Option<WsSink>>>,
    card_metadata: Arc<RwLock<std::collections::HashMap<String, CardMetadata>>>,
    pending_responses: PendingResponses,
}

#[derive(Debug, Clone, Deserialize)]
struct WeComWsMessage {
    #[serde(default)]
    cmd: String,
    #[allow(dead_code)]
    headers: Option<serde_json::Value>,
    body: Option<serde_json::Value>,
}

/// WeCom uses flat lowercase field names (msgid, chatid, msgtype, etc.)
/// See: https://developer.work.weixin.qq.com/document/path/101463
#[derive(Debug, Clone, Deserialize)]
struct WeComMsgCallback {
    #[serde(default)]
    msgid: String,
    #[serde(default)]
    chatid: String,
    #[serde(default)]
    chattype: String,
    #[serde(default)]
    from: Option<WeComFrom>,
    #[serde(default)]
    msgtype: String,
    // Content fields per msgtype
    #[serde(default)]
    text: Option<serde_json::Value>,
    #[serde(default)]
    voice: Option<serde_json::Value>,
    #[serde(default)]
    image: Option<serde_json::Value>,
    #[serde(default)]
    file: Option<serde_json::Value>,
    /// Quoted/referenced message when user replies to a message
    #[serde(default)]
    quote: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct WeComFrom {
    #[serde(default)]
    userid: String,
}

/// Metadata stored when a template card is sent for a question,
/// needed to update the card when the user clicks a button.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct CardMetadata {
    question_text: String,
    options: Vec<super::pending_question::QuestionOption>,
}

enum WsExitReason {
    Shutdown,
    Disconnected,
}

impl WeComGateway {
    pub fn new(
        acp: Arc<dyn AcpHandle>,
        store: Arc<dyn ChannelStore>,
        team_id: String,
        primary_agent_actor_id: String,
        agent_owner_actor_ids: Vec<String>,
        workspace_path: String,
    ) -> Self {
        Self {
            config: Arc::new(RwLock::new(WeComConfig::default())),
            acp,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
            workspace_path,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(WeComGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            processed_messages: Arc::new(RwLock::new(ProcessedMessageTracker::new(
                MAX_PROCESSED_MESSAGES,
            ))),
            pending_questions: Arc::new(super::PendingQuestionStore::new()),
            shared_ws_sink: Arc::new(RwLock::new(None)),
            card_metadata: Arc::new(RwLock::new(std::collections::HashMap::new())),
            pending_responses: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub async fn set_config(&self, config: WeComConfig) {
        *self.config.write().await = config;
    }

    /// The configured bot id for this gateway. Used by the channel manager to
    /// route bot-pinned sends and report per-bot status across a multi-bot fleet.
    pub async fn bot_id(&self) -> String {
        self.config.read().await.bot_id.clone()
    }

    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    pub async fn get_status(&self) -> WeComGatewayStatusResponse {
        self.status.read().await.clone()
    }

    async fn set_status(&self, status: WeComGatewayStatus, error: Option<String>) {
        let mut s = self.status.write().await;
        s.status = status;
        s.error_message = error;
    }

    pub async fn start(&self) -> Result<(), String> {
        let is_running = *self.is_running.read().await;
        if is_running {
            return Err("WeCom gateway is already running".to_string());
        }

        let config = self.config.read().await.clone();
        if config.bot_id.is_empty() || config.secret.is_empty() {
            return Err("WeCom bot_id and secret are required".to_string());
        }

        *self.is_running.write().await = true;
        *get_active_gateway_holder().write().await = Some(self.clone());
        self.set_status(WeComGatewayStatus::Connecting, None).await;

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        let gateway = self.clone();
        let bot_id = config.bot_id.clone();
        let secret = config.secret.clone();

        tokio::spawn(async move {
            gateway.run_gateway_loop(bot_id, secret, shutdown_rx).await;
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let shutdown_tx = self.shutdown_tx.write().await.take();
        if let Some(tx) = shutdown_tx {
            let _ = tx.send(());
        }
        *get_active_gateway_holder().write().await = None;
        *self.shared_ws_sink.write().await = None;
        *self.is_running.write().await = false;
        self.set_status(WeComGatewayStatus::Disconnected, None)
            .await;
        Ok(())
    }

    /// Consuming shutdown used by the amuxd channel manager.
    pub async fn shutdown(self) {
        if let Err(e) = self.stop().await {
            eprintln!("[WeCom] shutdown: {e}");
        }
    }

    async fn run_gateway_loop(
        &self,
        bot_id: String,
        secret: String,
        mut shutdown_rx: oneshot::Receiver<()>,
    ) {
        let mut backoff_secs = 2u64;

        loop {
            match self
                .connect_and_run(&bot_id, &secret, &mut shutdown_rx)
                .await
            {
                Ok(WsExitReason::Shutdown) => {
                    println!("[WeCom] Gateway shut down gracefully");
                    break;
                }
                Ok(WsExitReason::Disconnected) => {
                    backoff_secs = 2; // Reset after successful session
                    eprintln!("[WeCom] Disconnected, reconnecting in {}s", backoff_secs);
                    self.set_status(WeComGatewayStatus::Connecting, None).await;
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                        _ = &mut shutdown_rx => {
                            println!("[WeCom] Shutdown during reconnect backoff");
                            break;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[WeCom] Gateway error: {}", e);
                    self.set_status(WeComGatewayStatus::Error, Some(e)).await;
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                        _ = &mut shutdown_rx => {
                            println!("[WeCom] Shutdown during error backoff");
                            break;
                        }
                    }
                    backoff_secs = (backoff_secs * 2).min(60);
                }
            }
        }

        *self.is_running.write().await = false;
        *get_active_gateway_holder().write().await = None;
        self.set_status(WeComGatewayStatus::Disconnected, None)
            .await;
    }

    async fn connect_and_run(
        &self,
        bot_id: &str,
        secret: &str,
        shutdown_rx: &mut oneshot::Receiver<()>,
    ) -> Result<WsExitReason, String> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::connect_async;

        println!("[WeCom] Connecting to {}", WECOM_WS_ENDPOINT);

        let (ws_stream, _) = connect_async(WECOM_WS_ENDPOINT)
            .await
            .map_err(|e| format!("WebSocket connect failed: {}", e))?;

        let (mut ws_sink, mut ws_stream) = ws_stream.split();

        // Send aibot_subscribe
        let subscribe_msg = serde_json::json!({
            "cmd": "aibot_subscribe",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": { "bot_id": bot_id, "secret": secret }
        });
        ws_sink
            .send(tokio_tungstenite::tungstenite::Message::Text(
                subscribe_msg.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send subscribe: {}", e))?;

        // Wait for subscribe response (5s timeout)
        let subscribe_response =
            tokio::time::timeout(std::time::Duration::from_secs(5), ws_stream.next())
                .await
                .map_err(|_| "Subscribe response timeout".to_string())?
                .ok_or("WebSocket closed before subscribe response")?
                .map_err(|e| format!("Subscribe response error: {}", e))?;

        if let tokio_tungstenite::tungstenite::Message::Text(text) = subscribe_response {
            let resp: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("Invalid subscribe response: {}", e))?;
            // WeCom API uses "errcode"/"errmsg" fields (not "code"/"msg")
            let code = resp.get("errcode").and_then(|c| c.as_i64()).unwrap_or(-1);
            if code != 0 {
                let msg = resp
                    .get("errmsg")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(format!("Subscribe failed (code {}): {}", code, msg));
            }
            println!("[WeCom] Subscribed successfully");
        }

        self.set_status(WeComGatewayStatus::Connected, None).await;
        {
            let mut s = self.status.write().await;
            s.bot_id = Some(bot_id.to_string());
        }

        // Heartbeat task
        let ws_sink = Arc::new(tokio::sync::Mutex::new(ws_sink));
        *self.shared_ws_sink.write().await = Some(Arc::clone(&ws_sink));
        let ws_sink_hb = Arc::clone(&ws_sink);
        let (hb_shutdown_tx, mut hb_shutdown_rx) = mpsc::channel::<()>(1);

        let heartbeat_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS)) => {
                        use futures_util::SinkExt;
                        let ping_json = serde_json::json!({
                            "cmd": "ping",
                            "headers": { "req_id": uuid::Uuid::new_v4().to_string() }
                        });
                        let ping = tokio_tungstenite::tungstenite::Message::Text(
                            ping_json.to_string().into(),
                        );
                        if let Err(e) = ws_sink_hb.lock().await.send(ping).await {
                            eprintln!("[WeCom] Heartbeat ping failed: {}", e);
                            break;
                        }
                    }
                    _ = hb_shutdown_rx.recv() => {
                        break;
                    }
                }
            }
        });

        // Main event loop
        let exit_reason = loop {
            tokio::select! {
                msg = ws_stream.next() => {
                    match msg {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                            let ws_sink_clone = Arc::clone(&ws_sink);
                            // Spawn message handling as a separate task so we don't block the WS loop
                            // (same pattern as Feishu gateway)
                            let gateway = self.clone();
                            tokio::spawn(async move {
                                gateway.handle_ws_message(&text, ws_sink_clone).await;
                            });
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Pong(_))) => {
                            // Heartbeat pong received
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => {
                            println!("[WeCom] WebSocket closed by server");
                            break WsExitReason::Disconnected;
                        }
                        Some(Err(e)) => {
                            eprintln!("[WeCom] WebSocket error: {}", e);
                            break WsExitReason::Disconnected;
                        }
                        None => {
                            println!("[WeCom] WebSocket stream ended");
                            break WsExitReason::Disconnected;
                        }
                        _ => {} // Ignore binary, etc.
                    }
                }
                _ = &mut *shutdown_rx => {
                    println!("[WeCom] Shutdown signal received");
                    break WsExitReason::Shutdown;
                }
            }
        };

        *self.shared_ws_sink.write().await = None;
        let _ = hb_shutdown_tx.send(()).await;
        heartbeat_handle.abort();
        Ok(exit_reason)
    }

    async fn handle_ws_message(&self, text: &str, ws_sink: WsSink) {
        let msg: WeComWsMessage = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[WeCom] Failed to parse message: {}", e);
                return;
            }
        };

        match msg.cmd.as_str() {
            "aibot_msg_callback" => {
                println!(
                    "[WeCom] Received msg callback: {}",
                    text.chars().take(2000).collect::<String>()
                );
                if let Some(body) = msg.body {
                    let callback: WeComMsgCallback = match serde_json::from_value(body) {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[WeCom] Failed to parse callback: {}", e);
                            return;
                        }
                    };
                    // Extract original req_id for reply
                    let req_id = msg
                        .headers
                        .as_ref()
                        .and_then(|h| h.get("req_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    self.handle_message_callback(callback, req_id, ws_sink)
                        .await;
                }
            }
            "aibot_event_callback" => {
                println!(
                    "[WeCom] Received event callback: {}",
                    text.chars().take(500).collect::<String>()
                );
                if let Some(body) = msg.body {
                    let eventtype = body
                        .get("event")
                        .and_then(|e| e.get("eventtype"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let req_id = msg
                        .headers
                        .as_ref()
                        .and_then(|h| h.get("req_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    match eventtype {
                        "enter_chat" => {
                            self.handle_enter_chat(&req_id, &ws_sink).await;
                        }
                        "template_card_event" => {
                            self.handle_template_card_event(&body, &req_id, &ws_sink)
                                .await;
                        }
                        "disconnected_event" => {
                            println!("[WeCom] Disconnected by server (new connection established)");
                        }
                        "feedback_event" => {
                            let feedback = body
                                .get("event")
                                .and_then(|e| e.get("feedback"))
                                .and_then(|f| f.as_str())
                                .unwrap_or("unknown");
                            println!("[WeCom] User feedback received: {}", feedback);
                        }
                        _ => {
                            println!("[WeCom] Unhandled event type: {}", eventtype);
                        }
                    }
                }
            }
            "" => {
                // WeCom acknowledgment/response — route to pending waiters or log errors
                let raw: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
                let req_id = raw
                    .get("headers")
                    .and_then(|h| h.get("req_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // If someone is waiting for this req_id, deliver the response
                if !req_id.is_empty() {
                    let mut pending = self.pending_responses.lock().await;
                    if let Some(tx) = pending.remove(req_id) {
                        let _ = tx.send(raw.clone());
                        return;
                    }
                }

                // Otherwise log errors as before
                if let Some(body) = &msg.body {
                    let errcode = body.get("errcode").and_then(|c| c.as_i64()).unwrap_or(0);
                    if errcode != 0 {
                        let errmsg = body.get("errmsg").and_then(|m| m.as_str()).unwrap_or("");
                        eprintln!("[WeCom] Response error: code={}, msg={}", errcode, errmsg);
                    }
                }
                let errcode = raw.get("errcode").and_then(|c| c.as_i64()).unwrap_or(0);
                if errcode != 0 {
                    let errmsg = raw.get("errmsg").and_then(|m| m.as_str()).unwrap_or("");
                    eprintln!("[WeCom] Response error: code={}, msg={}", errcode, errmsg);
                }
            }
            _ => {
                println!("[WeCom] Unhandled command: {}", msg.cmd);
            }
        }
    }

    async fn handle_message_callback(
        &self,
        msg: WeComMsgCallback,
        req_id: String,
        ws_sink: WsSink,
    ) {
        let userid = msg.from.as_ref().map(|f| f.userid.as_str()).unwrap_or("");
        println!(
            "[WeCom] Callback: msgid={}, msgtype={}, chattype={}, userid={}",
            msg.msgid, msg.msgtype, msg.chattype, userid
        );
        // Deduplication
        if !self.mark_message_processed(&msg.msgid).await {
            return;
        }

        // Extract content based on msgtype
        // WeCom puts content in type-specific fields: text.content, voice.content, image.url, etc.
        let mut text_content = String::new();
        let mut image_url: Option<String> = None;
        let mut filename_hint: Option<String> = None;
        let mut media_aeskey: Option<String> = None;

        match msg.msgtype.as_str() {
            "text" => {
                text_content = msg
                    .text
                    .as_ref()
                    .and_then(|t| t.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            "voice" => {
                text_content = msg
                    .voice
                    .as_ref()
                    .and_then(|v| v.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            "image" => {
                println!("[WeCom] Image message body: {:?}", msg.image);
                image_url = msg
                    .image
                    .as_ref()
                    .and_then(|i| {
                        // Try "url" first, then "img_url", then "pic_url"
                        i.get("url")
                            .or_else(|| i.get("img_url"))
                            .or_else(|| i.get("pic_url"))
                    })
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if image_url.is_none() {
                    println!("[WeCom] Image message has no URL field");
                    return;
                }
                // Extract per-message AES key for encrypted images
                media_aeskey = msg
                    .image
                    .as_ref()
                    .and_then(|i| i.get("aeskey"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
            "file" => {
                println!("[WeCom] File message body: {:?}", msg.file);
                let file_url = msg
                    .file
                    .as_ref()
                    .and_then(|f| f.get("url"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if file_url.is_none() {
                    println!("[WeCom] File message has no URL field");
                    return;
                }
                // Extract filename for MIME detection fallback
                filename_hint = msg
                    .file
                    .as_ref()
                    .and_then(|f| f.get("filename"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                // Extract per-message AES key for encrypted files
                media_aeskey = msg
                    .file
                    .as_ref()
                    .and_then(|f| f.get("aeskey"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                // Treat file like image — download and send as data URL
                image_url = file_url;
            }
            _ => {
                println!("[WeCom] Unsupported message type: {}", msg.msgtype);
                return;
            }
        };

        // Strip @mention prefix in group messages (e.g. "@蕉你一手 /help" → "/help")
        if msg.chattype == "group" && !text_content.is_empty() {
            if let Some(stripped) = text_content.trim().strip_prefix('@') {
                // Find end of mention (first space after @name)
                if let Some(space_pos) = stripped.find(' ') {
                    text_content = stripped[space_pos..].trim().to_string();
                }
                // If no space found, the entire message is just "@botname" with no content
            }
        }

        // Extract quoted/referenced message content
        // WeCom puts quoted messages in a "quote" field with structure:
        //   { "msgtype": "text", "text": { "content": "..." } }
        if let Some(ref quote) = msg.quote {
            let quoted_text = quote
                .get("text")
                .and_then(|t| t.get("content"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            // Check for question marker in quoted text
            if let Some(qid) = super::extract_question_marker(quoted_text) {
                if let Some(entry) = self.pending_questions.take_by_question_id(qid).await {
                    let _ = entry.answer_tx.send(text_content.clone());
                    println!(
                        "[WeCom] Question {} answered via quote reply",
                        entry.question_id
                    );
                    return;
                }
            }

            // Original behavior: prepend quoted text for context
            if !quoted_text.is_empty() {
                text_content = format!(
                    "[Quoted message]\n{}\n[End quoted message]\n\n{}",
                    quoted_text, text_content
                );
            }
        }

        // Collect raw inbound attachments. WeCom delivers images/files
        // encrypted under a per-message aeskey; decrypt now, defer the
        // backend attachment upload until we know the resolved session_id.
        struct InboundFile {
            bytes: Vec<u8>,
            filename: String,
            mime: String,
        }
        let mut inbound_files: Vec<InboundFile> = Vec::new();
        if let Some(url) = image_url.as_deref() {
            let aeskey = media_aeskey.as_deref().unwrap_or("");
            match download_and_decrypt_wecom_media(url, aeskey, filename_hint.as_deref()).await {
                Ok((bytes, detected_mime)) => {
                    if bytes.len() > 50 * 1024 * 1024 {
                        tracing::warn!(
                            "WeCom file too large ({} bytes); skipping attachment",
                            bytes.len()
                        );
                    } else {
                        let filename = filename_hint.clone().unwrap_or_else(|| {
                            format!(
                                "wecom-{}.{}",
                                chrono::Utc::now().timestamp_millis(),
                                mime_to_ext(&detected_mime)
                            )
                        });
                        inbound_files.push(InboundFile {
                            bytes,
                            filename,
                            mime: detected_mime,
                        });
                    }
                }
                Err(e) => tracing::warn!("WeCom file decrypt failed: {e}"),
            }
        }

        // For inbound attachments, allow empty text — the agent should still
        // see the files. Only drop the event when there's no text AND no
        // files we successfully decoded.
        if text_content.trim().is_empty() && inbound_files.is_empty() {
            return;
        }

        // Auto-record ownerId on first DM if not yet set
        if msg.chattype == "single" && !userid.is_empty() {
            let config = self.config.read().await;
            if config.owner_id.is_none() {
                drop(config);
                let mut config = self.config.write().await;
                // Double-check after acquiring write lock
                if config.owner_id.is_none() {
                    config.owner_id = Some(userid.to_string());
                    println!("[WeCom] Auto-recorded ownerId: {}", userid);
                    // Persist to config file
                    if let Ok(mut file_config) = super::read_config(&self.workspace_path) {
                        let channels = file_config
                            .channels
                            .get_or_insert_with(super::config::ChannelsConfig::default);
                        if let Some(ref mut wecom) = channels.wecom {
                            wecom.owner_id = Some(userid.to_string());
                        } else {
                            channels.wecom = Some(WeComConfig {
                                owner_id: Some(userid.to_string()),
                                ..Default::default()
                            });
                        }
                        let _ = super::write_config(&self.workspace_path, &file_config);
                    }
                }
            }
        }

        // Check for /answer command — routes reply to the most recent pending question
        if let Some(answer_text) = super::PendingQuestionStore::parse_answer_command(&text_content)
        {
            let locale = i18n::get_locale(&self.workspace_path);
            if let Some(qid) = self.pending_questions.try_answer(answer_text).await {
                println!(
                    "[WeCom] Question {} answered via /answer: {}",
                    qid, answer_text
                );
                let _ = self
                    .send_reply(
                        &req_id,
                        &i18n::t(i18n::MsgKey::AnswerSubmitted(answer_text), locale),
                        &ws_sink,
                    )
                    .await;
            } else {
                let _ = self
                    .send_reply(
                        &req_id,
                        &i18n::t(i18n::MsgKey::NoPendingQuestions, locale),
                        &ws_sink,
                    )
                    .await;
            }
            return;
        }

        // Slash commands that don't need a resolved session (/help, unknown)
        // are short-circuited here; those that do need a session fall through
        // and are dispatched after session resolve below.
        let trimmed_early = text_content.trim();
        if !trimmed_early.is_empty() && trimmed_early.starts_with('/') {
            if let Some((cmd_name, _)) = commands::parse_slash(trimmed_early) {
                let needs_session =
                    matches!(cmd_name.as_str(), "stop" | "reset" | "model" | "sessions" | "agents" | "workspaces" | "clear" | "ctx");
                if !needs_session {
                    // /help or any ACP-advertised command that doesn't need a session
                    // is handled generically; unknown commands also land here.
                    // We have no session yet, so pass a placeholder session id.
                    use std::sync::{Arc as SArc, Mutex};
                    let reply_cell: SArc<Mutex<Option<String>>> = SArc::new(Mutex::new(None));
                    let reply_cell_clone = reply_cell.clone();
                    let handled = commands::dispatch(
                        &cmd_name,
                        None,
                        self.acp.as_ref(),
                        self.store.as_ref(),
                        &String::new(),
                        move |r| {
                            *reply_cell_clone.lock().unwrap() = Some(r);
                        },
                    )
                    .await
                    .unwrap_or(false);
                    let reply_text = reply_cell.lock().unwrap().take();
                    if handled {
                        if let Some(text) = reply_text {
                            let _ = self.send_reply(&req_id, &text, &ws_sink).await;
                        }
                    } else {
                        let locale = i18n::get_locale(&self.workspace_path);
                        let _ = self
                            .send_reply(
                                &req_id,
                                &i18n::t(i18n::MsgKey::UnknownCommand(&format!("/{cmd_name}")), locale),
                                &ws_sink,
                            )
                            .await;
                    }
                    return;
                }
                // session-requiring commands fall through to session resolve below.
            }
        }

        // Determine chat type and build binding URI per spec:
        //   wecom://{corp_id}/{agent_id}/{single|external-single|group}/{userid|chat_id}
        // WSS smart-bot only exposes bot_id; use it for both corp_id and agent_id slots.
        let chat_type_str = msg.chattype.as_str();
        let bot_id = {
            let cfg = self.config.read().await;
            cfg.bot_id.clone()
        };
        let chat_id = msg.chatid.clone();

        // Group only flows when the bot is @-mentioned (per spec — only @bot exchanges persist).
        // WeCom's group callback already strips/keeps the @mention prefix in text_content; presence
        // of the message itself signals delivery to the bot, which only happens on @mention.
        // We additionally guard non-text/non-bot-mention noise by requiring non-empty trimmed text.
        if chat_type_str == "group" {
            // The "@蕉你一手" prefix was stripped earlier. If text is now empty
            // and there are no attachments (e.g. an image sent with no caption),
            // ignore — otherwise let it through so the agent sees the files.
            if text_content.trim().is_empty() && inbound_files.is_empty() {
                println!("[WeCom] Group message dropped: no text and no attachments");
                return;
            }
        }

        let binding = match chat_type_str {
            "single" => crate::binding::wecom_dm(&bot_id, &bot_id, userid),
            "external-single" => crate::binding::wecom_external_dm(&bot_id, &bot_id, userid),
            "group" => crate::binding::wecom_group(&bot_id, &bot_id, &chat_id),
            _ => {
                println!("[WeCom] Unknown chattype: {}", chat_type_str);
                return;
            }
        };

        let source_id_urn = if chat_type_str == "external-single" {
            crate::binding::urn_wecom_ext(&bot_id, userid)
        } else {
            crate::binding::urn_wecom_user(&bot_id, userid)
        };

        let sender_display_name = userid.to_string();

        let external_actor_id = match self
            .store
            .ensure_external_actor(&self.team_id, "wecom", &source_id_urn, &sender_display_name)
            .await
        {
            Ok(id) => id,
            Err(e) => {
                let _ = self
                    .send_reply(&req_id, &format!("Error (actor): {}", e), &ws_sink)
                    .await;
                return;
            }
        };

        let session_title = match chat_type_str {
            "single" => format!("WeCom DM: {}", sender_display_name),
            "external-single" => format!("WeCom external: {}", sender_display_name),
            "group" => format!("WeCom group: {}", chat_id),
            _ => "WeCom".to_string(),
        };

        let outcome = match self
            .store
            .ensure_session(
                &self.team_id,
                &binding,
                &session_title,
                &self.primary_agent_actor_id,
                &self.agent_owner_actor_ids,
                std::slice::from_ref(&external_actor_id),
            )
            .await
        {
            Ok(o) => o,
            Err(e) => {
                let _ = self
                    .send_reply(&req_id, &format!("Error (session): {}", e), &ws_sink)
                    .await;
                return;
            }
        };

        if let Err(e) = self
            .store
            .add_participant(&outcome.session_id, &external_actor_id)
            .await
        {
            eprintln!("[WeCom] add_participant failed: {}", e);
        }

        // Slash-command dispatch: two-layer (ACP agent commands first, then
        // gateway meta-commands: /help, /model, /sessions, /agents,
        // /workspaces, /clear, /stop, /ctx).
        if let Some((cmd_name, cmd_arg)) = commands::parse_slash(text_content.trim()) {
            use std::sync::{Arc as SArc, Mutex};
            let reply_cell: SArc<Mutex<Option<String>>> = SArc::new(Mutex::new(None));
            let reply_cell_clone = reply_cell.clone();
            let handled = commands::dispatch(
                &cmd_name,
                cmd_arg.as_deref(),
                self.acp.as_ref(),
                self.store.as_ref(),
                &outcome.acp_session_id,
                move |r| {
                    *reply_cell_clone.lock().unwrap() = Some(r);
                },
            )
            .await
            .unwrap_or(false);
            let reply_text = reply_cell.lock().unwrap().take();
            if handled {
                if let Some(text) = reply_text {
                    let _ = self.send_reply(&req_id, &text, &ws_sink).await;
                }
            } else {
                let locale = i18n::get_locale(&self.workspace_path);
                let _ = self
                    .send_reply(
                        &req_id,
                        &i18n::t(i18n::MsgKey::UnknownCommand(&format!("/{cmd_name}")), locale),
                        &ws_sink,
                    )
                    .await;
            }
            return;
        }

        // Dual-write attachments: save to local cache for the agent to read,
        // then upload to backend attachment storage in parallel with the ACP turn so the
        // bot reply latency is unaffected by upload time.
        let local_dir = dirs::config_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
            .join("amux")
            .join("attachments")
            .join(&outcome.session_id);
        if !inbound_files.is_empty() {
            if let Err(e) = tokio::fs::create_dir_all(&local_dir).await {
                tracing::warn!("attachment cache mkdir failed: {e}");
            }
        }

        // (bucket_path, filename, mime, size, local_path, inline_data_url)
        // `inline_data_url` is set for small images so the Tauri/iOS clients can
        // render an actual thumbnail (same convention the desktop client's own
        // upload path uses) instead of a bare filename placeholder.
        const INLINE_IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;
        let mut attachment_descriptors: Vec<(String, String, String, usize, Option<String>, Option<String>)> =
            Vec::new();
        let mut upload_handles: Vec<tokio::task::JoinHandle<Result<String, String>>> = Vec::new();
        let mut local_paths_for_prompt: Vec<String> = Vec::new();

        for f in inbound_files {
            let local_path = local_dir.join(&f.filename);
            if let Err(e) = tokio::fs::write(&local_path, &f.bytes).await {
                tracing::warn!("attachment local write failed for {:?}: {e}", local_path);
                continue;
            }
            let local_path_str = local_path.to_string_lossy().to_string();
            local_paths_for_prompt.push(local_path_str.clone());

            let bucket_path = format!(
                "{}/{}/{}-{}",
                self.team_id,
                outcome.session_id,
                uuid::Uuid::new_v4(),
                f.filename,
            );

            let inline_data_url = if f.mime.starts_with("image/") && f.bytes.len() <= INLINE_IMAGE_MAX_BYTES {
                Some(format!(
                    "data:{};base64,{}",
                    f.mime,
                    base64::engine::general_purpose::STANDARD.encode(&f.bytes)
                ))
            } else {
                None
            };

            attachment_descriptors.push((
                bucket_path.clone(),
                f.filename.clone(),
                f.mime.clone(),
                f.bytes.len(),
                Some(local_path_str),
                inline_data_url,
            ));

            // Parallel upload — does not block ACP.
            let store = self.store.clone();
            let mime = f.mime.clone();
            let bytes = f.bytes;
            upload_handles.push(tokio::spawn(async move {
                store
                    .upload_attachment(&bucket_path, bytes, &mime)
                    .await
                    .map_err(|e| e.to_string())
            }));
        }

        // Build prompt with local-path references so the agent can `Read` them.
        let mut prompt_text = text_content.clone();
        if !local_paths_for_prompt.is_empty() {
            prompt_text.push_str("\n\n[Attached files — read these with the Read tool]\n");
            for p in &local_paths_for_prompt {
                prompt_text.push_str(&format!("- {}\n", p));
            }
        }

        // Show an immediate placeholder so the sender doesn't see "no reply"
        // while the agent thinks. WeCom's stream msgtype lets us replace the
        // bubble's content by re-sending the same `id` — first chunk goes
        // out with finish=false, the final reply re-uses the same id with
        // finish=true so the placeholder is overwritten in place.
        let stream_id = uuid::Uuid::new_v4().to_string();
        let _ = self
            .send_stream_chunk(&req_id, &stream_id, "💭 正在思考…", false, &ws_sink)
            .await;

        // Progressive rendering: `send_prompt_streamed` pushes the cumulative
        // reply text as the agent produces it, and each update overwrites the
        // same bubble. Runs on its own task so the turn is never blocked by a
        // slow WebSocket write; dropping `update_tx` (when the turn returns)
        // closes the channel and ends the task.
        let (update_tx, mut update_rx) = mpsc::channel::<String>(32);
        let stream_task = {
            let req_id = req_id.clone();
            let stream_id = stream_id.clone();
            let ws_sink = ws_sink.clone();
            tokio::spawn(async move {
                while let Some(text) = update_rx.recv().await {
                    if let Err(e) =
                        Self::send_stream_chunk_static(&req_id, &stream_id, &text, false, &ws_sink)
                            .await
                    {
                        eprintln!("[WeCom] Stream update failed: {}", e);
                        break;
                    }
                }
            })
        };

        // Drive a single ACP turn through amuxd — runs in parallel with the
        // attachment uploads spawned above.
        let reply_result = self
            .acp
            .send_prompt_streamed(
                &outcome.acp_session_id,
                &sender_display_name,
                &prompt_text,
                update_tx,
            )
            .await;

        // Drain pending updates before the final frame: a `finish=false`
        // chunk landing after `finish=true` would re-open the bubble and
        // leave stale text in it.
        let _ = stream_task.await;

        let reply = match reply_result {
            Ok(r) => r,
            Err(e) => {
                let _ = self
                    .send_stream_chunk(
                        &req_id,
                        &stream_id,
                        &format!("Error: {}", e),
                        true,
                        &ws_sink,
                    )
                    .await;
                return;
            }
        };

        // Collect upload results. Upload failure falls back to a metadata-only
        // record pointing at the local cache so the agent's reply still has
        // context, even though Tauri clients won't be able to download.
        let mut attachments: Vec<AttachmentRecord> = Vec::new();
        // Rendering fragments for the stored user-message content, using the
        // same placeholder conventions the desktop client's own upload path
        // produces (`packages/app/src/packages/ai/message.tsx::parseMessageContent`):
        // images small enough to inline get `[Image: name]\n<data-url>` so
        // Tauri/iOS clients render a real thumbnail; everything else falls
        // back to a `[Attachment: name] (size)` chip.
        let mut content_fragments: Vec<String> = Vec::new();
        for ((bucket_path, filename, mime, size, local_path, inline_data_url), handle) in
            attachment_descriptors.into_iter().zip(upload_handles)
        {
            let upload_result = handle
                .await
                .unwrap_or_else(|_| Err("upload task panic".into()));
            if let Err(e) = &upload_result {
                tracing::warn!("attachment upload failed (kept local copy): {e}");
            }
            let bucket_path = if upload_result.is_ok() {
                bucket_path
            } else {
                String::new()
            };

            content_fragments.push(match &inline_data_url {
                Some(data_url) => format!("[Image: {}]\n{}", filename, data_url),
                None => format!("[Attachment: {}] ({})", filename, human_readable_size(size)),
            });

            attachments.push(AttachmentRecord {
                filename,
                mime,
                size,
                bucket_path,
                local_path,
            });
        }

        // Build the stored user-message content so Tauri/iOS clients see the
        // attached files rendered (image thumbnail or file chip) rather than a
        // raw text placeholder.
        let user_content = if content_fragments.is_empty() {
            text_content.clone()
        } else if text_content.trim().is_empty() {
            content_fragments.join("\n")
        } else {
            format!("{}\n{}", text_content, content_fragments.join("\n"))
        };

        if let Err(e) = self
            .store
            .record_message_with_attachments(
                &outcome.session_id,
                &external_actor_id,
                &user_content,
                Some(&msg.msgid),
                attachments,
            )
            .await
        {
            eprintln!("[WeCom] record_message_with_attachments (user) failed: {}", e);
        }

        if let Err(e) = self
            .store
            .record_agent_reply(
                &outcome.session_id,
                &self.primary_agent_actor_id,
                &reply.reply_text,
                None,
            )
            .await
        {
            eprintln!("[WeCom] record_agent_reply failed: {}", e);
        }

        // Group chats prepend a plain `@userid` so the final stream chunk
        // visually marks who the reply is for. WeCom's stream msgtype has no
        // documented mention markup (`<@id>` rendered as literal text), so
        // this is presentational only — no push notification, no clickable
        // mention. Single/external-single chats stay prefix-free.
        let final_text = if chat_type_str == "group" {
            format!("@{} {}", userid, reply.reply_text)
        } else {
            reply.reply_text.clone()
        };

        let _ = self
            .send_stream_chunk(&req_id, &stream_id, &final_text, true, &ws_sink)
            .await;
    }

    async fn mark_message_processed(&self, msg_id: &str) -> bool {
        let mut tracker = self.processed_messages.write().await;
        !tracker.is_duplicate(msg_id)
    }

    /// Handle enter_chat event — send welcome message
    async fn handle_enter_chat(&self, req_id: &str, ws_sink: &WsSink) {
        use futures_util::SinkExt;

        let locale = i18n::get_locale(&self.workspace_path);
        let welcome = serde_json::json!({
            "cmd": "aibot_respond_welcome_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "text",
                "text": {
                    "content": i18n::t(i18n::MsgKey::WecomWelcome, locale)
                }
            }
        });

        match ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                welcome.to_string().into(),
            ))
            .await
        {
            Ok(_) => println!("[WeCom] Welcome message sent"),
            Err(e) => eprintln!("[WeCom] Failed to send welcome message: {}", e),
        }
    }

    /// Handle template_card_event — user clicked a button on a template card
    async fn handle_template_card_event(
        &self,
        body: &serde_json::Value,
        req_id: &str,
        ws_sink: &WsSink,
    ) {
        use futures_util::SinkExt;

        // Extract the clicked button key from the event
        let event = match body.get("event") {
            Some(e) => e,
            None => {
                eprintln!("[WeCom] Template card event missing 'event' field");
                return;
            }
        };

        let selected_key = event
            .get("selected_items")
            .and_then(|items| items.as_array())
            .and_then(|arr| arr.first())
            .and_then(|item| item.get("key"))
            .and_then(|k| k.as_str())
            .or_else(|| event.get("key").and_then(|k| k.as_str()))
            .unwrap_or("");

        if selected_key.is_empty() {
            println!("[WeCom] Template card event with no selected key");
            return;
        }

        println!("[WeCom] Template card button clicked: key={}", selected_key);

        // Parse key format: "q:{question_id}:{option_index}:{option_value}"
        let parts: Vec<&str> = selected_key.splitn(4, ':').collect();
        if parts.len() < 4 || parts[0] != "q" {
            println!("[WeCom] Unexpected button key format: {}", selected_key);
            return;
        }
        let question_id = parts[1];
        let option_index: usize = parts[2].parse().unwrap_or(0);
        let option_value = parts[3];

        // Answer the pending question
        if let Some(entry) = self
            .pending_questions
            .take_by_question_id(question_id)
            .await
        {
            let _ = entry.answer_tx.send(option_value.to_string());
            println!(
                "[WeCom] Question {} answered via card: {}",
                question_id, option_value
            );
        } else {
            println!("[WeCom] No pending question found for id={}", question_id);
        }

        // Update the card — highlight selected button, grey out others
        let metadata = self.card_metadata.write().await.remove(question_id);
        if let Some(meta) = metadata {
            let button_list: Vec<serde_json::Value> = meta
                .options
                .iter()
                .enumerate()
                .map(|(i, opt)| {
                    let value = opt.value.as_deref().unwrap_or(&opt.label);
                    let (text, style) = if i == option_index {
                        (format!("✓ {}", opt.label), 1) // highlighted
                    } else {
                        (opt.label.clone(), 2) // grey
                    };
                    serde_json::json!({
                        "text": text,
                        "style": style,
                        "key": format!("q:{}:{}:{}", question_id, i, value)
                    })
                })
                .collect();

            let task_id = format!("q:{}", question_id);

            let update_msg = serde_json::json!({
                "cmd": "aibot_respond_update_msg",
                "headers": { "req_id": req_id },
                "body": {
                    "response_type": "update_template_card",
                    "template_card": {
                        "card_type": "button_interaction",
                        "main_title": { "title": "AI Question" },
                        "sub_title_text": meta.question_text,
                        "button_list": button_list,
                        "task_id": task_id
                    }
                }
            });

            match ws_sink
                .lock()
                .await
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    update_msg.to_string().into(),
                ))
                .await
            {
                Ok(_) => println!("[WeCom] Card updated: task_id={}", task_id),
                Err(e) => eprintln!("[WeCom] Failed to update card: {}", e),
            }
        }
    }

    /// Send a template card with buttons for a question that has options.
    /// Currently unused: WeCom doesn't render template_card after a stream
    /// response on the same req_id, and aibot_send_msg with template_card
    /// also fails to deliver. Kept for future investigation.
    #[allow(dead_code)]
    async fn send_question_card(
        &self,
        question_id: &str,
        question_text: &str,
        options: &[super::pending_question::QuestionOption],
        ws_sink: &WsSink,
        chatid: &str,
        chat_type: u32,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let button_list: Vec<serde_json::Value> = options
            .iter()
            .enumerate()
            .map(|(i, opt)| {
                let value = opt.value.as_deref().unwrap_or(&opt.label);
                serde_json::json!({
                    "text": opt.label,
                    "style": 1,
                    "key": format!("q:{}:{}:{}", question_id, i, value)
                })
            })
            .collect();

        let task_id = format!("q:{}", question_id);

        let card_msg = serde_json::json!({
            "cmd": "aibot_send_msg",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": {
                "chatid": chatid,
                "chat_type": chat_type,
                "msgtype": "template_card",
                "template_card": {
                    "card_type": "button_interaction",
                    "main_title": { "title": "AI Question" },
                    "sub_title_text": question_text,
                    "button_list": button_list,
                    "task_id": task_id
                }
            }
        });

        println!(
            "[WeCom] Sending question card via aibot_send_msg: chatid={}, chat_type={}, task_id={}, payload={}",
            chatid, chat_type, task_id, card_msg
        );

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                card_msg.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send question card: {}", e))?;

        // Store metadata for card update when button is clicked
        self.card_metadata.write().await.insert(
            question_id.to_string(),
            CardMetadata {
                question_text: question_text.to_string(),
                options: options.to_vec(),
            },
        );

        println!(
            "[WeCom] Question card sent successfully: task_id={}",
            task_id
        );
        Ok(())
    }

    async fn send_stream_chunk(
        &self,
        req_id: &str,
        stream_id: &str,
        content: &str,
        finish: bool,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let reply = serde_json::json!({
            "cmd": "aibot_respond_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "stream",
                "stream": {
                    "id": stream_id,
                    "finish": finish,
                    "content": content,
                },
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                reply.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send reply: {}", e))
    }

    /// Static version of send_stream_chunk for use in spawned tasks (no &self needed)
    async fn send_stream_chunk_static(
        req_id: &str,
        stream_id: &str,
        content: &str,
        finish: bool,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let reply = serde_json::json!({
            "cmd": "aibot_respond_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": "stream",
                "stream": {
                    "id": stream_id,
                    "finish": finish,
                    "content": content,
                },
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                reply.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send reply: {}", e))
    }

    /// Send a proactive message to a WeCom conversation via aibot_send_msg.
    /// Requires the gateway to be connected and the target user to have
    /// previously messaged the bot in that conversation.
    pub async fn send_chat_message(
        &self,
        chatid: &str,
        chat_type: u32,
        text: &str,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let ws_sink = self.shared_ws_sink.read().await.clone().ok_or_else(|| {
            "WeCom gateway is not connected. Cannot send proactive message.".to_string()
        })?;

        let msg = serde_json::json!({
            "cmd": "aibot_send_msg",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": {
                "chatid": chatid,
                "chat_type": chat_type,
                "msgtype": "markdown",
                "markdown": { "content": text }
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                msg.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send proactive message: {}", e))?;

        println!(
            "[WeCom] Proactive message sent to chatid={}, chat_type={}",
            chatid, chat_type
        );
        Ok(())
    }

    /// Simple non-streaming reply (for slash commands and errors)
    async fn send_reply(&self, req_id: &str, text: &str, ws_sink: &WsSink) -> Result<(), String> {
        let stream_id = uuid::Uuid::new_v4().to_string();
        self.send_stream_chunk(req_id, &stream_id, text, true, ws_sink)
            .await
    }

    /// Send a WS command and wait for the response (matched by req_id).
    async fn ws_request(
        &self,
        msg: serde_json::Value,
        req_id: &str,
        ws_sink: &WsSink,
    ) -> Result<serde_json::Value, String> {
        use futures_util::SinkExt;

        let (tx, rx) = oneshot::channel();
        self.pending_responses
            .lock()
            .await
            .insert(req_id.to_string(), tx);

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                msg.to_string().into(),
            ))
            .await
            .map_err(|e| {
                // Clean up on send failure
                let pending = self.pending_responses.clone();
                let rid = req_id.to_string();
                tokio::spawn(async move {
                    pending.lock().await.remove(&rid);
                });
                format!("Failed to send WS request: {}", e)
            })?;

        tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| "WS request timed out".to_string())?
            .map_err(|_| "WS response channel closed".to_string())
    }

    /// Upload media data to WeCom via the 3-step WebSocket upload protocol.
    /// `media_type` is one of: "image", "voice", "video", "file".
    /// Returns the media_id on success.
    async fn upload_media(
        &self,
        data: &[u8],
        filename: &str,
        media_type: &str,
        ws_sink: &WsSink,
    ) -> Result<String, String> {
        let md5_hash = format!("{:x}", md5::compute(data));
        let total_size = data.len();
        const CHUNK_SIZE: usize = 512 * 1024; // Max 512KB per chunk
        let total_chunks = total_size.div_ceil(CHUNK_SIZE);

        // Step 1: Init
        let init_req_id = uuid::Uuid::new_v4().to_string();
        let init_msg = serde_json::json!({
            "cmd": "aibot_upload_media_init",
            "headers": { "req_id": &init_req_id },
            "body": {
                "type": media_type,
                "filename": filename,
                "total_size": total_size,
                "total_chunks": total_chunks,
                "md5": &md5_hash,
            }
        });
        let init_resp = self.ws_request(init_msg, &init_req_id, ws_sink).await?;
        let upload_id = init_resp
            .get("body")
            .and_then(|b| b.get("upload_id"))
            .and_then(|u| u.as_str())
            .ok_or_else(|| {
                format!(
                    "No upload_id in init response: {}",
                    serde_json::to_string(&init_resp).unwrap_or_default()
                )
            })?
            .to_string();

        println!(
            "[WeCom] Media upload init: type={}, upload_id={}, chunks={}",
            media_type, upload_id, total_chunks
        );

        // Step 2: Upload chunks
        for i in 0..total_chunks {
            let start = i * CHUNK_SIZE;
            let end = (start + CHUNK_SIZE).min(total_size);
            let chunk_data = base64::engine::general_purpose::STANDARD.encode(&data[start..end]);

            let chunk_req_id = uuid::Uuid::new_v4().to_string();
            let chunk_msg = serde_json::json!({
                "cmd": "aibot_upload_media_chunk",
                "headers": { "req_id": &chunk_req_id },
                "body": {
                    "upload_id": &upload_id,
                    "chunk_index": i,
                    "base64_data": &chunk_data,
                }
            });
            let chunk_resp = self.ws_request(chunk_msg, &chunk_req_id, ws_sink).await?;
            let errcode = chunk_resp
                .get("body")
                .and_then(|b| b.get("errcode"))
                .and_then(|c| c.as_i64())
                .unwrap_or(0);
            if errcode != 0 {
                return Err(format!("Upload chunk {} failed: {:?}", i, chunk_resp));
            }
        }

        // Step 3: Finish
        let finish_req_id = uuid::Uuid::new_v4().to_string();
        let finish_msg = serde_json::json!({
            "cmd": "aibot_upload_media_finish",
            "headers": { "req_id": &finish_req_id },
            "body": {
                "upload_id": &upload_id,
            }
        });
        let finish_resp = self.ws_request(finish_msg, &finish_req_id, ws_sink).await?;
        let media_id = finish_resp
            .get("body")
            .and_then(|b| b.get("media_id"))
            .and_then(|m| m.as_str())
            .ok_or_else(|| {
                format!(
                    "No media_id in finish response: {}",
                    serde_json::to_string(&finish_resp).unwrap_or_default()
                )
            })?
            .to_string();

        println!(
            "[WeCom] Media upload complete: type={}, media_id={}",
            media_type,
            &media_id[..media_id.len().min(20)]
        );
        Ok(media_id)
    }

    /// Send a media message as a reply (image/voice/video/file).
    #[allow(dead_code)]
    async fn send_media_reply(
        &self,
        req_id: &str,
        media_id: &str,
        media_type: &str,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let reply = serde_json::json!({
            "cmd": "aibot_respond_msg",
            "headers": { "req_id": req_id },
            "body": {
                "msgtype": media_type,
                media_type: { "media_id": media_id },
            }
        });

        ws_sink
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                reply.to_string().into(),
            ))
            .await
            .map_err(|e| format!("Failed to send {} reply: {}", media_type, e))
    }

    /// Upload file bytes and send as a reply. Convenience wrapper.
    #[allow(dead_code)]
    async fn upload_and_send_media_reply(
        &self,
        req_id: &str,
        data: &[u8],
        filename: &str,
        media_type: &str,
        ws_sink: &WsSink,
    ) -> Result<(), String> {
        let media_id = self
            .upload_media(data, filename, media_type, ws_sink)
            .await?;
        self.send_media_reply(req_id, &media_id, media_type, ws_sink)
            .await
    }

    /// Proactive send wrapper for the `amuxd mcp-server` MCP `send` tool.
    /// `user_id` is a WeCom internal/external userid; chat_type is fixed at
    /// 1 (single chat). Optionally uploads + sends a file before the text.
    pub async fn send_to_user_with_optional_media(
        &self,
        user_id: &str,
        text: &str,
        media: Option<(Vec<u8>, String)>,
    ) -> Result<(), String> {
        if let Some((bytes, filename)) = media {
            let ws_sink = self
                .shared_ws_sink
                .read()
                .await
                .clone()
                .ok_or_else(|| "WeCom gateway is not connected.".to_string())?;
            let media_type = detect_media_type(&filename);
            let media_id = self
                .upload_media(&bytes, &filename, media_type, &ws_sink)
                .await?;
            self.send_media_to_chat(user_id, 1, &media_id, media_type)
                .await?;
        }
        if !text.is_empty() {
            self.send_chat_message(user_id, 1, text).await?;
        }
        Ok(())
    }

    /// Proactive send wrapper for the `amuxd mcp-server` MCP `send` tool.
    /// `chat_id` is a WeCom group chat id; chat_type is fixed at 2 (group).
    /// Optionally uploads + sends a file before the text.
    pub async fn send_to_chat_with_optional_media(
        &self,
        chat_id: &str,
        text: &str,
        media: Option<(Vec<u8>, String)>,
    ) -> Result<(), String> {
        if let Some((bytes, filename)) = media {
            let ws_sink = self
                .shared_ws_sink
                .read()
                .await
                .clone()
                .ok_or_else(|| "WeCom gateway is not connected.".to_string())?;
            let media_type = detect_media_type(&filename);
            let media_id = self
                .upload_media(&bytes, &filename, media_type, &ws_sink)
                .await?;
            self.send_media_to_chat(chat_id, 2, &media_id, media_type)
                .await?;
        }
        if !text.is_empty() {
            self.send_chat_message(chat_id, 2, text).await?;
        }
        Ok(())
    }

    /// Send a media message proactively to a chat (image/voice/video/file).
    pub async fn send_media_to_chat(
        &self,
        chatid: &str,
        chat_type: u32,
        media_id: &str,
        media_type: &str,
    ) -> Result<(), String> {
        use futures_util::SinkExt;

        let ws_sink = self
            .shared_ws_sink
            .read()
            .await
            .clone()
            .ok_or_else(|| "WeCom gateway is not connected.".to_string())?;

        let msg = serde_json::json!({
            "cmd": "aibot_send_msg",
            "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
            "body": {
                "chatid": chatid,
                "chat_type": chat_type,
                "msgtype": media_type,
                media_type: { "media_id": media_id },
            }
        });

        let text = msg.to_string();
        let mut guard = ws_sink.lock().await;
        guard
            .send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
            .await
            .map_err(|e| format!("Failed to send {}: {}", media_type, e))
    }

}

/// Map a filename to a WeCom `msgtype` string (`image` / `voice` / `video` /
/// `file`). Used by the proactive-send wrappers (and the MCP `send` tool)
/// to pick the right upload protocol from a bare file path.
fn detect_media_type(filename: &str) -> &'static str {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" => "image",
        "mp3" | "amr" | "wav" | "ogg" | "m4a" | "aac" => "voice",
        "mp4" | "mov" | "avi" | "mkv" | "wmv" => "video",
        _ => "file",
    }
}

/// Send a proactive message to a WeCom conversation.
/// Called by cron delivery and other modules that don't have direct gateway access.
/// Requires the WeCom gateway to be running and connected.
pub async fn send_proactive_message(
    chatid: &str,
    chat_type: u32,
    text: &str,
) -> Result<(), String> {
    let gateway = get_active_gateway_holder()
        .read()
        .await
        .clone()
        .ok_or_else(|| {
            "WeCom gateway is not running. Start the WeCom gateway before sending proactive messages.".to_string()
        })?;

    gateway.send_chat_message(chatid, chat_type, text).await
}

/// Upload media and send it to a WeCom conversation.
/// `media_type` is one of: "image", "voice", "video", "file".
/// Called by the introspect API for MCP media sending.
pub async fn upload_and_send_media(
    chatid: &str,
    chat_type: u32,
    data: &[u8],
    filename: &str,
    media_type: &str,
) -> Result<(), String> {
    let gateway = get_active_gateway_holder()
        .read()
        .await
        .clone()
        .ok_or_else(|| {
            "WeCom gateway is not running. Start the WeCom gateway before sending media."
                .to_string()
        })?;

    let ws_sink = gateway
        .shared_ws_sink
        .read()
        .await
        .clone()
        .ok_or_else(|| "WeCom gateway is not connected.".to_string())?;

    let media_id = gateway
        .upload_media(data, filename, media_type, &ws_sink)
        .await?;
    gateway
        .send_media_to_chat(chatid, chat_type, &media_id, media_type)
        .await
}

#[cfg(test)]
mod mime_tests {
    use super::*;

    const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    #[test]
    fn magic_detects_png() {
        let bytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(detect_mime_from_magic(&bytes).as_deref(), Some("image/png"));
    }

    #[test]
    fn magic_detects_zip_for_ooxml_local_file_header() {
        // Every xlsx/docx/pptx file starts with the ZIP local file header.
        let bytes = [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00];
        assert_eq!(
            detect_mime_from_magic(&bytes).as_deref(),
            Some("application/zip")
        );
    }

    #[test]
    fn magic_detects_legacy_office_compound_doc() {
        let bytes = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00];
        assert_eq!(
            detect_mime_from_magic(&bytes).as_deref(),
            Some("application/x-cfb")
        );
    }

    #[test]
    fn filename_detects_xlsx() {
        assert_eq!(
            detect_mime_from_filename("report.xlsx").as_deref(),
            Some(XLSX_MIME)
        );
    }

    #[test]
    fn resolve_mime_xlsx_with_filename_returns_ooxml_subtype() {
        // PK header + filename → filename wins so we get the precise OOXML mime.
        let bytes = [0x50, 0x4B, 0x03, 0x04];
        assert_eq!(resolve_mime(&bytes, Some("quarterly.xlsx")), XLSX_MIME);
    }

    #[test]
    fn resolve_mime_plain_zip_without_filename_returns_zip() {
        // A minimal ZIP header with no recognizable OOXML entries → application/zip.
        let bytes = [0x50, 0x4B, 0x03, 0x04];
        let mime = resolve_mime(&bytes, None);
        assert_eq!(mime, "application/zip");
        assert_ne!(mime, "image/png");
    }

    #[test]
    fn detect_ooxml_xlsx_from_zip_entries() {
        // Simulate a minimal xlsx ZIP with an entry named "xl/workbook.xml"
        let entry_name = b"xl/workbook.xml";
        let mut bytes = Vec::new();
        // Local file header
        bytes.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]); // signature
        bytes.extend_from_slice(&[0x14, 0x00]); // version needed
        bytes.extend_from_slice(&[0x00, 0x00]); // flags
        bytes.extend_from_slice(&[0x00, 0x00]); // compression method (stored)
        bytes.extend_from_slice(&[0x00, 0x00]); // last mod time
        bytes.extend_from_slice(&[0x00, 0x00]); // last mod date
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // crc32
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // compressed size
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // uncompressed size
        bytes.extend_from_slice(&(entry_name.len() as u16).to_le_bytes()); // filename length
        bytes.extend_from_slice(&[0x00, 0x00]); // extra field length
        bytes.extend_from_slice(entry_name); // filename
        let mime = resolve_mime(&bytes, None);
        assert_eq!(mime, XLSX_MIME);
    }

    #[test]
    fn detect_ooxml_docx_from_zip_entries() {
        // Simulate a minimal docx ZIP with an entry named "word/document.xml"
        let entry_name = b"word/document.xml";
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]);
        bytes.extend_from_slice(&[0x14, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&(entry_name.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(entry_name);
        let mime = resolve_mime(&bytes, None);
        assert_eq!(
            mime,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
    }

    #[test]
    fn detect_ooxml_pptx_from_zip_entries() {
        // Simulate a minimal pptx ZIP with an entry named "ppt/presentation.xml"
        let entry_name = b"ppt/presentation.xml";
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]);
        bytes.extend_from_slice(&[0x14, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(&(entry_name.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&[0x00, 0x00]);
        bytes.extend_from_slice(entry_name);
        let mime = resolve_mime(&bytes, None);
        assert_eq!(
            mime,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        );
    }

    #[test]
    fn content_disposition_extracts_filename() {
        assert_eq!(
            extract_filename_from_content_disposition(r#"attachment; filename="report.xlsx""#),
            Some("report.xlsx".to_string())
        );
    }

    #[test]
    fn content_disposition_extracts_utf8_filename() {
        assert_eq!(
            extract_filename_from_content_disposition(
                "attachment; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.xlsx"
            ),
            Some("\u{62a5}\u{8868}.xlsx".to_string())
        );
    }

    #[test]
    fn content_disposition_returns_none_for_missing() {
        assert_eq!(
            extract_filename_from_content_disposition("attachment"),
            None
        );
    }

    #[test]
    fn resolve_mime_unknown_bytes_no_filename_returns_octet_stream() {
        // Regression: previously defaulted to image/png.
        let bytes = [0x00, 0x01, 0x02, 0x03];
        assert_eq!(resolve_mime(&bytes, None), "application/octet-stream");
    }

    #[test]
    fn resolve_mime_filename_without_extension_falls_through_to_magic() {
        let bytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(resolve_mime(&bytes, Some("noext")), "image/png");
    }

    #[test]
    fn mime_to_ext_xlsx() {
        assert_eq!(mime_to_ext(XLSX_MIME), "xlsx");
    }

    #[test]
    fn mime_to_ext_unknown_returns_bin() {
        assert_eq!(mime_to_ext("application/x-totally-unknown"), "bin");
    }

    #[test]
    fn ext_from_filename_xlsx_with_chinese_stem() {
        assert_eq!(ext_from_filename("Q3 报表.xlsx"), Some("xlsx".to_string()));
    }

    #[test]
    fn ext_from_filename_uppercase_normalized() {
        assert_eq!(ext_from_filename("DOC.PDF"), Some("pdf".to_string()));
    }

    #[test]
    fn ext_from_filename_no_dot_returns_none() {
        assert_eq!(ext_from_filename("noext"), None);
    }

    #[test]
    fn ext_from_filename_dotfile_returns_none() {
        assert_eq!(ext_from_filename(".hidden"), None);
    }

    #[test]
    fn ext_from_filename_trailing_dot_returns_none() {
        assert_eq!(ext_from_filename("name."), None);
    }

    #[test]
    fn ext_from_filename_non_alphanumeric_extension_returns_none() {
        // Defends against weird extensions that could break filename construction.
        assert_eq!(ext_from_filename("foo.tar/gz"), None);
    }
}
