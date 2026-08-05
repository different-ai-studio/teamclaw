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

use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// The one page a user sees outside the app, so it matches the other
/// out-of-app surface we ship — the release download page built by
/// `scripts/publish-oss-release.py`. Tokens are deliberately copied from that
/// file's `build_css` so the two stay recognisably the same system: black
/// ground, coral accent with a glow, 22px icon tile, uppercase pill.
///
/// This is NOT the in-app Editorial Calm palette from AGENTS.md §1 — that one
/// governs the three-column desktop shell, not a standalone browser tab.
///
/// Everything is inlined: the page is served straight off a throwaway loopback
/// listener with no asset pipeline, and must render identically offline.
///
/// The page names no product. This is a multi-brand build, and
/// `branding::brand_name` falls back to the literal "TeamClaw" whenever a brand
/// ships without `product_name` — so printing the name here would quietly show
/// the wrong brand instead of failing loudly. Same reason there is no logo: only
/// the brand *name* ever reached this code, never its mark or accent, so the
/// coral below is the default one from the release page.
const PAGE_TEMPLATE: &str = r#"<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{TITLE_CN}}</title>
<style>
  :root {
    --bg: #000;
    --bg-card: #141414;
    --tx: #fff;
    --tx2: rgba(255, 255, 255, .7);
    --tx3: rgba(255, 255, 255, .5);
    --tx4: rgba(255, 255, 255, .35);
    --accent: #ff8b7b;
    --accent2: #ff6b5a;
    --glow: rgba(255, 139, 123, .4);
    --bd: rgba(255, 255, 255, .08);
    --grad: linear-gradient(135deg, #ff8b7b 0%, #ff6b5a 100%);
    color-scheme: dark;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                 'PingFang SC', 'Microsoft YaHei', sans-serif;
    background: var(--bg);
    color: var(--tx);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    position: relative;
    overflow-x: hidden;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: radial-gradient(ellipse 80% 50% at 50% -10%, rgba(255, 139, 123, .15), transparent 70%);
    pointer-events: none;
    z-index: 0;
  }
  .card {
    width: 100%;
    max-width: 440px;
    text-align: center;
    position: relative;
    z-index: 1;
  }
  .mark {
    width: 84px;
    height: 84px;
    margin: 0 auto;
    border-radius: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mark.ok {
    background: var(--grad);
    color: #1a0e0b;
    box-shadow: 0 0 40px var(--glow), 0 8px 30px rgba(0, 0, 0, .6);
  }
  .mark.bad {
    background: var(--bg-card);
    border: 1px solid rgba(255, 139, 123, .35);
    color: var(--accent);
    box-shadow: 0 8px 30px rgba(0, 0, 0, .6);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 22px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .12em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid rgba(255, 139, 123, .35);
    background: rgba(255, 139, 123, .08);
    border-radius: 999px;
    padding: 4px 13px;
  }
  .badge .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent2);
    box-shadow: 0 0 8px var(--glow);
  }
  h1 {
    font-size: 30px;
    font-weight: 800;
    margin: 16px 0 6px;
    letter-spacing: -.02em;
    line-height: 1.15;
  }
  .meta {
    color: var(--tx3);
    font-size: 14px;
    margin-bottom: 30px;
  }
  .panel {
    background: var(--bg-card);
    border: 1px solid var(--bd);
    border-radius: 16px;
    padding: 18px 20px;
    color: var(--tx2);
    font-size: 13.5px;
    line-height: 1.6;
  }
  .panel .en {
    margin-top: 4px;
    color: var(--tx4);
    font: 12px/1.5 ui-monospace, 'SF Mono', Menlo, monospace;
  }
</style>
<body>
  <main class="card">
    <div class="mark {{MARK_CLASS}}">{{MARK_SVG}}</div>
    <div class="badge"><span class="dot"></span>{{BADGE}}</div>
    <h1>{{TITLE_CN}}</h1>
    <p class="meta">{{TITLE_EN}}</p>
    <div class="panel">
      <p>{{BODY_CN}}</p>
      <p class="en">{{BODY_EN}}</p>
    </div>
  </main>
</body>
</html>"#;

const CHECK_SVG: &str = r#"<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>"#;

const CROSS_SVG: &str = r#"<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>"#;

struct PageCopy<'a> {
    /// Coral pill above the headline, matching the release page's BETA badge.
    badge: &'a str,
    title_cn: &'a str,
    title_en: &'a str,
    body_cn: &'a str,
    body_en: &'a str,
    mark_svg: &'a str,
    /// `ok` (filled coral tile) or `bad` (outlined tile) — see PAGE_TEMPLATE.
    mark_class: &'a str,
}

fn render_page(copy: PageCopy<'_>) -> String {
    PAGE_TEMPLATE
        .replace("{{MARK_CLASS}}", copy.mark_class)
        .replace("{{MARK_SVG}}", copy.mark_svg)
        .replace("{{BADGE}}", copy.badge)
        .replace("{{TITLE_CN}}", copy.title_cn)
        .replace("{{TITLE_EN}}", copy.title_en)
        .replace("{{BODY_CN}}", copy.body_cn)
        .replace("{{BODY_EN}}", copy.body_en)
}

fn success_html() -> String {
    render_page(PageCopy {
        badge: "Signed in",
        title_cn: "登录成功",
        title_en: "Google account connected",
        body_cn: "你可以关闭此页面，返回应用继续。",
        body_en: "You can close this tab and return to the app.",
        mark_svg: CHECK_SVG,
        mark_class: "ok",
    })
}

fn error_html() -> String {
    render_page(PageCopy {
        badge: "Sign-in failed",
        title_cn: "登录未完成",
        title_en: "We could not complete the sign-in",
        body_cn: "请关闭此页面，返回应用重试。",
        body_en: "Close this tab and try again from the app.",
        mark_svg: CROSS_SVG,
        mark_class: "bad",
    })
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
    state: State<'_, OAuthLoopbackState>,
) -> Result<LoopbackStart, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("oauth_bind_failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("oauth_addr_failed: {e}"))?
        .port();
    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let handle = tokio::spawn(async move {
        let _ = tx.send(accept_one(listener).await);
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

async fn accept_one(listener: TcpListener) -> Result<String, String> {
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
        Ok(_) => ("200 OK", success_html()),
        Err(_) => ("400 Bad Request", error_html()),
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

    /// The page is brand-neutral on purpose. `branding::brand_name` falls back to
    /// the literal "TeamClaw" whenever a brand ships without `product_name`, so
    /// naming the product here would print the wrong one for those builds rather
    /// than fail loudly. The copy says "应用" / "the app" instead.
    #[test]
    fn pages_name_no_product() {
        for html in [success_html(), error_html()] {
            assert!(!html.contains("TeamClaw"));
            assert!(html.contains("应用"));
        }
    }

    /// Served straight off the loopback socket with no asset pipeline, so a
    /// reference to any external origin would render as a broken page offline.
    #[test]
    fn pages_are_self_contained() {
        for html in [success_html(), error_html()] {
            assert!(!html.contains("http://"));
            assert!(!html.contains("https://"));
        }
    }
}
