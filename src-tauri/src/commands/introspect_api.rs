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
    let listener =
        TcpListener::bind(format!("127.0.0.1:{}", INTROSPECT_API_PORT)).await?;
    println!(
        "[IntrospectAPI] Listening on 127.0.0.1:{}",
        INTROSPECT_API_PORT
    );

    loop {
        let (mut stream, _peer) = listener.accept().await?;
        let app_clone = app.clone();

        tokio::spawn(async move {
            let mut buf = vec![0u8; 16384];
            let n = match stream.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            let raw = &buf[..n];

            // Parse: first line = "METHOD /path HTTP/x.x"
            let header_end = match find_double_crlf(raw) {
                Some(i) => i,
                None => {
                    let _ = write_response(&mut stream, 400, "Bad Request").await;
                    return;
                }
            };

            let header_str = match std::str::from_utf8(&raw[..header_end]) {
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

            // Body starts after \r\n\r\n
            let body_start = header_end + 4;
            let body_bytes = if body_start < n {
                &raw[body_start..n]
            } else {
                &[]
            };

            let resp = match (method, path) {
                ("POST", "/send-wecom") => {
                    handle_send_wecom(body_bytes).await
                }
                ("POST", "/cron-run") => {
                    handle_cron_run(&app_clone, body_bytes).await
                }
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
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let target = v
        .get("target")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let message = v
        .get("message")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: message")?;

    // Parse target format: "single:{userid}" or "group:{chatid}" or bare chatid
    let (chatid, chat_type) = if let Some(userid) = target.strip_prefix("single:") {
        (userid, 1u32)
    } else if let Some(chatid) = target.strip_prefix("group:") {
        (chatid, 2u32)
    } else {
        // Treat bare value as single user (chat_type=1)
        (target, 1u32)
    };

    teamclaw_gateway::wecom::send_proactive_message(chatid, chat_type, message).await?;

    Ok(format!(
        r#"{{"ok":true,"chatid":"{}","chat_type":{}}}"#,
        chatid, chat_type
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

/// Find the position of `\r\n\r\n` in `data`, returning the index of the first `\r`.
fn find_double_crlf(data: &[u8]) -> Option<usize> {
    data.windows(4)
        .position(|w| w == b"\r\n\r\n")
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
