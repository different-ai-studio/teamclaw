/// Internal HTTP API server for the teamclaw-introspect MCP binary.
///
/// Listens on 127.0.0.1:13144 and handles:
///   POST /send-wecom   — send a proactive WeCom message
///   POST /cron-run     — manually trigger a cron job
///
/// Uses raw TCP + manual HTTP parsing to stay minimal (no axum state needed).

pub const INTROSPECT_API_PORT: u16 = 13144;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub async fn start_introspect_api(app: AppHandle) -> anyhow::Result<()> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", INTROSPECT_API_PORT)).await?;
    println!(
        "[IntrospectAPI] Listening on 127.0.0.1:{}",
        INTROSPECT_API_PORT
    );

    loop {
        let (mut stream, _peer) = listener.accept().await?;
        let app_clone = app.clone();

        tokio::spawn(async move {
            // Read initial chunk (headers + maybe partial body)
            let mut buf = vec![0u8; 65536];
            let n = match stream.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };

            // Parse headers
            let header_end = match find_double_crlf(&buf[..n]) {
                Some(i) => i,
                None => {
                    let _ = write_response(&mut stream, 400, "Bad Request").await;
                    return;
                }
            };

            let header_str = match std::str::from_utf8(&buf[..header_end]) {
                Ok(s) => s,
                Err(_) => {
                    let _ = write_response(&mut stream, 400, "Bad Request").await;
                    return;
                }
            };

            let first_line = header_str.lines().next().unwrap_or("");
            let mut parts = first_line.splitn(3, ' ');
            let method = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("");

            // Parse Content-Length for large bodies (e.g. image base64)
            let content_length: usize = header_str
                .lines()
                .find_map(|line| {
                    let lower = line.to_ascii_lowercase();
                    lower
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse().ok())
                })
                .unwrap_or(0);

            // Read remaining body if needed
            let body_start = header_end + 4;
            let mut body_buf: Vec<u8> = buf[body_start..n].to_vec();
            while body_buf.len() < content_length {
                let mut chunk = vec![0u8; 65536];
                match stream.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(cn) => body_buf.extend_from_slice(&chunk[..cn]),
                    Err(_) => break,
                }
            }
            let body_bytes = &body_buf[..];

            let resp = match (method, path) {
                ("POST", "/send-wecom") => handle_send_wecom(body_bytes).await,
                ("POST", "/cron-run") => handle_cron_run(&app_clone, body_bytes).await,
                _ => Err(format!("Not found: {} {}", method, path)),
            };

            let (status, body) = match resp {
                Ok(msg) => (200u16, msg),
                Err(e) => (500u16, e),
            };
            let _ = write_response(&mut stream, status, &body).await;
        });
    }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async fn handle_send_wecom(body: &[u8]) -> Result<String, String> {
    use base64::Engine as _;

    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let target = v.get("target").and_then(|v| v.as_str()).unwrap_or("");
    let message = v.get("message").and_then(|v| v.as_str()).unwrap_or("");

    // Parse target format: "single:{userid}" or "group:{chatid}" or bare chatid
    let (chatid, chat_type) = if let Some(userid) = target.strip_prefix("single:") {
        (userid, 1u32)
    } else if let Some(chatid) = target.strip_prefix("group:") {
        (chatid, 2u32)
    } else {
        // Treat bare value as single user (chat_type=1)
        (target, 1u32)
    };

    // Send text message if provided
    if !message.is_empty() {
        teamclaw_gateway::wecom::send_proactive_message(chatid, chat_type, message).await?;
    }

    // Send media file if provided (image/voice/video/file)
    let media_sent = if let Some(b64) = v.get("media_base64").and_then(|v| v.as_str()) {
        let data = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Invalid media base64: {}", e))?;
        let filename = v
            .get("media_filename")
            .and_then(|v| v.as_str())
            .unwrap_or("file");
        let media_type = v
            .get("media_type")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| detect_media_type(filename));

        teamclaw_gateway::wecom::upload_and_send_media(
            chatid, chat_type, &data, filename, media_type,
        )
        .await?;
        true
    } else {
        false
    };

    Ok(format!(
        r#"{{"ok":true,"chatid":"{}","chat_type":{},"media_sent":{}}}"#,
        chatid, chat_type, media_sent
    ))
}

async fn handle_cron_run(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let job_id = v
        .get("job_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: job_id")?;

    let cron_state = app.state::<super::cron::CronState>();

    let job = cron_state
        .storage
        .get_job(job_id)
        .await
        .ok_or_else(|| format!("Job not found: {}", job_id))?;

    let scheduler = cron_state.scheduler.clone();
    tokio::spawn(async move {
        scheduler.execute_job(job).await;
    });

    Ok(format!(r#"{{"ok":true,"job_id":"{}"}}"#, job_id))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Detect WeCom media type from filename extension.
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

/// Find the position of `\r\n\r\n` in `data`, returning the index of the first `\r`.
fn find_double_crlf(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|w| w == b"\r\n\r\n")
}

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Error" };
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await
}
