//! One-shot loopback HTTP listener that captures the OAuth redirect `code`.
//!
//! `oauth_loopback_start` binds 127.0.0.1 on a random port and spawns a task
//! that accepts a single connection, parses `?code=` (or `?error=`) from the
//! request line, replies with a small HTML page, and hands the result back via
//! a oneshot channel. `oauth_loopback_await` awaits that result with a timeout.
//!
//! `oauth_loopback_cancel` lets the UI abort an in-flight attempt (e.g. the user
//! returned from a broken provider page) instead of being stuck behind the long
//! await timeout. The accept-task abort handle lives in the state separately
//! from the result receiver so cancel can fire it even while `await` holds the
//! receiver: aborting the task drops its sender, which makes the awaiting
//! receiver resolve with a recv error that maps to `oauth_cancelled`.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

fn success_html(brand: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>{brand}</title>\
         <body style=\"font-family:system-ui;text-align:center;padding-top:18vh\">\
         <h2>登录成功 / Signed in</h2><p>你可以关闭此页面返回 {brand}。<br>You can close this tab.</p></body>"
    )
}

fn error_html(brand: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>{brand}</title>\
         <body style=\"font-family:system-ui;text-align:center;padding-top:18vh\">\
         <h2>登录失败 / Sign-in failed</h2><p>请返回 {brand} 重试。<br>Please return to {brand} and try again.</p></body>"
    )
}

#[derive(Default)]
pub struct OAuthLoopbackState {
    /// Result receiver for the current attempt. Taken by `await`.
    pending: Mutex<Option<oneshot::Receiver<Result<String, String>>>>,
    /// Abort handle for the parked accept() task. Kept here (not bundled into
    /// `pending`) so `cancel` can fire it while `await` holds the receiver.
    accept_task: Mutex<Option<tokio::task::AbortHandle>>,
}

#[derive(serde::Serialize)]
pub struct LoopbackStart {
    pub port: u16,
}

#[derive(serde::Serialize)]
pub struct LoopbackCode {
    pub code: String,
}

#[tauri::command]
pub async fn oauth_loopback_start(
    app: tauri::AppHandle,
    state: State<'_, OAuthLoopbackState>,
) -> Result<LoopbackStart, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("oauth_bind_failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("oauth_addr_failed: {e}"))?
        .port();
    let brand = crate::branding::brand_name(app.config().product_name.as_deref());
    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let handle = tokio::spawn(async move {
        let _ = tx.send(accept_one(listener, brand).await);
    });
    // Replace any in-flight listener (e.g. a prior cancelled attempt) and abort
    // its task so we don't leak a parked accept() / bound port across retries.
    state.pending.lock().unwrap().replace(rx);
    if let Some(prev) = state
        .accept_task
        .lock()
        .unwrap()
        .replace(handle.abort_handle())
    {
        prev.abort();
    }
    Ok(LoopbackStart { port })
}

#[tauri::command]
pub async fn oauth_loopback_await(
    state: State<'_, OAuthLoopbackState>,
) -> Result<LoopbackCode, String> {
    let rx = {
        // Drop the guard before awaiting — never hold a std Mutex across .await.
        // Leave `accept_task` in place so `cancel` can still abort us.
        state
            .pending
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| "oauth_no_pending".to_string())?
    };
    let outcome = match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Err(_) => Err("oauth_timeout".to_string()),
        // Sender dropped without a value — almost always `cancel`/`start` aborted
        // the accept() task.
        Ok(Err(_)) => Err("oauth_cancelled".to_string()),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Ok(Ok(code))) => Ok(code),
    };
    // The attempt is over: abort the parked accept() task (if any) so the port is
    // freed, and clear the handle so a later stray cancel can't hit a new flow.
    if let Some(handle) = state.accept_task.lock().unwrap().take() {
        handle.abort();
    }
    outcome.map(|code| LoopbackCode { code })
}

/// Abort the in-flight OAuth attempt so a blocked `await` returns immediately as
/// `oauth_cancelled`. Safe to call when nothing is pending (no-op).
#[tauri::command]
pub async fn oauth_loopback_cancel(state: State<'_, OAuthLoopbackState>) -> Result<(), String> {
    if let Some(handle) = state.accept_task.lock().unwrap().take() {
        handle.abort();
    }
    // Drop any not-yet-awaited receiver too, so a fresh start is clean.
    state.pending.lock().unwrap().take();
    Ok(())
}

async fn accept_one(listener: TcpListener, brand: String) -> Result<String, String> {
    let (mut socket, _) = listener
        .accept()
        .await
        .map_err(|e| format!("oauth_accept_failed: {e}"))?;
    let mut buf = vec![0u8; 8192];
    let n = socket
        .read(&mut buf)
        .await
        .map_err(|e| format!("oauth_read_failed: {e}"))?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let target = req
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");
    let result = parse_callback_target(target);

    let (status, body) = match &result {
        Ok(_) => ("200 OK", success_html(&brand)),
        Err(_) => ("400 Bad Request", error_html(&brand)),
    };
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(resp.as_bytes()).await;
    let _ = socket.flush().await;
    result
}

/// Extract `code` (success) or `error`/`error_description` (failure) from a
/// request target like `/callback?code=abc&state=xyz`.
fn parse_callback_target(target: &str) -> Result<String, String> {
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code: Option<String> = None;
    let mut err: Option<String> = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let value = urldecode(v);
        match k {
            "code" => code = Some(value),
            "error_description" => err = Some(value),
            "error" => err = err.or(Some(value)),
            _ => {}
        }
    }
    match code {
        Some(c) if !c.is_empty() => Ok(c),
        _ => Err(err.unwrap_or_else(|| "oauth_no_code".to_string())),
    }
}

/// Minimal percent-decoder for query values (`%XX` and `+` → space).
fn urldecode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_code_from_target() {
        assert_eq!(
            parse_callback_target("/callback?code=abc123&state=xyz"),
            Ok("abc123".to_string())
        );
    }

    #[test]
    fn url_decodes_code_value() {
        assert_eq!(
            parse_callback_target("/callback?code=a%2Bb%2Fc"),
            Ok("a+b/c".to_string())
        );
    }

    #[test]
    fn returns_error_when_no_code() {
        assert_eq!(
            parse_callback_target(
                "/callback?error=access_denied&error_description=user%20cancelled"
            ),
            Err("user cancelled".to_string())
        );
    }

    #[test]
    fn returns_default_error_for_empty_query() {
        assert_eq!(
            parse_callback_target("/callback"),
            Err("oauth_no_code".to_string())
        );
    }

    // The cancel path relies on this invariant: aborting the accept() task drops
    // its sender, so the awaiting receiver resolves to a recv error which
    // `oauth_loopback_await` maps to `oauth_cancelled`.
    #[tokio::test]
    async fn aborting_accept_task_resolves_receiver_as_cancelled() {
        let (tx, rx) = oneshot::channel::<Result<String, String>>();
        let handle = tokio::spawn(async move {
            // Park forever, like a real accept() waiting for a callback.
            std::future::pending::<()>().await;
            let _ = tx.send(Ok("never".to_string()));
        });
        handle.abort();
        let mapped = match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Err(_) => "oauth_timeout",
            Ok(Err(_)) => "oauth_cancelled",
            Ok(Ok(_)) => "resolved",
        };
        assert_eq!(mapped, "oauth_cancelled");
    }
}

#[cfg(test)]
mod brand_html_tests {
    use super::{error_html, success_html};

    #[test]
    fn success_html_includes_brand_name() {
        let html = success_html("Acme");
        assert!(html.contains("Acme"));
        assert!(!html.contains("TeamClaw"));
    }

    #[test]
    fn error_html_includes_brand_name() {
        let html = error_html("Acme");
        assert!(html.contains("Acme"));
        assert!(!html.contains("TeamClaw"));
    }
}
