//! Local fast-path: subscribe to the daemon's `GET /v1/live/events` SSE and
//! forward each frame to the webview as `mqtt:envelopes` — the exact event
//! shape the MQTT bridge emits (`[{topic, b64}]`).
//!
//! The daemon tees every session/live publish (identical bytes, identical
//! event_id) into this stream BEFORE the MQTT publish, so a same-machine UI
//! streams at loopback latency and keeps working when the broker is slow or
//! unreachable. The webview's existing eventId dedup drops whichever copy
//! (SSE vs MQTT) arrives second; events lost on one path are backfilled by
//! the other.
//!
//! Lifecycle: one background task spawned at app setup. It loops forever:
//! discover the daemon HTTP listener via `~/.amuxd/amuxd.http.{port,token}`,
//! exchange a scoped token, hold the SSE open, and on any error/EOF back off
//! and retry — daemon restarts and re-onboards are picked up automatically.

use futures_util::StreamExt;
use serde::Deserialize;
use tauri::Emitter;

#[derive(Debug, Deserialize)]
struct AuthExchangeResponse {
    token: String,
}

fn daemon_http_base() -> Option<(String, String)> {
    let amuxd_dir = dirs::home_dir()?.join(".amuxd");
    let port: u16 = std::fs::read_to_string(amuxd_dir.join("amuxd.http.port"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let root_token = std::fs::read_to_string(amuxd_dir.join("amuxd.http.token"))
        .ok()?
        .trim()
        .to_string();
    Some((format!("http://127.0.0.1:{port}"), root_token))
}

/// Spawn the persistent SSE subscriber. Call once from the Tauri setup hook.
pub fn spawn(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let mut announced_up = false;
        loop {
            match run_once(&client, &app, &mut announced_up).await {
                Ok(()) => {
                    // Stream ended cleanly (daemon shutdown) — retry soon.
                }
                Err(e) => {
                    tracing::debug!("[daemon-live] stream unavailable: {e}");
                }
            }
            if announced_up {
                announced_up = false;
                let _ = app.emit("daemon-live:connected", false);
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
}

async fn run_once(
    client: &reqwest::Client,
    app: &tauri::AppHandle,
    announced_up: &mut bool,
) -> Result<(), String> {
    let Some((base, root_token)) = daemon_http_base() else {
        return Err("daemon http port/token files not present".into());
    };

    let exchange: AuthExchangeResponse = client
        .post(format!("{base}/v1/auth/exchange"))
        .header("Authorization", format!("Bearer {root_token}"))
        .json(&serde_json::json!({
            "scopes": ["events:read"],
            "ttl_seconds": 86400,
        }))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("auth exchange: {e}"))?
        .json()
        .await
        .map_err(|e| format!("auth exchange decode: {e}"))?;

    let resp = client
        .get(format!("{base}/v1/live/events"))
        .header("Authorization", format!("Bearer {}", exchange.token))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("sse connect: {e}"))?;

    tracing::info!("[daemon-live] connected to {base}/v1/live/events");
    *announced_up = true;
    let _ = app.emit("daemon-live:connected", true);

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("sse read: {e}"))?;
        buf.extend_from_slice(&chunk);

        // Frames are `data: {...}\n\n`; heartbeats are `:hb\n\n` comments.
        // Collect every complete frame in this chunk into ONE emit (mirrors
        // the MQTT bridge's burst coalescing).
        let mut batch: Vec<serde_json::Value> = Vec::new();
        while let Some(pos) = find_frame_end(&buf) {
            let frame: Vec<u8> = buf.drain(..pos + 2).collect();
            let Ok(text) = std::str::from_utf8(&frame) else {
                continue;
            };
            for line in text.lines() {
                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                match serde_json::from_str::<serde_json::Value>(data) {
                    Ok(v) if v.get("topic").is_some() && v.get("b64").is_some() => batch.push(v),
                    _ => tracing::warn!("[daemon-live] unparseable frame: {data}"),
                }
            }
        }
        if !batch.is_empty() {
            let _ = app.emit("mqtt:envelopes", batch);
        }
    }
    Ok(())
}

fn find_frame_end(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_end_finds_double_newline() {
        assert_eq!(find_frame_end(b"data: {}\n\nrest"), Some(8));
        assert_eq!(find_frame_end(b"partial"), None);
    }
}
