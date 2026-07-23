use tauri::{Runtime, Webview};

use crate::error::Error;
use super::{InputResult, MouseButton, MouseParams, TextParams, TextResult};
use super::js_fallback;

// TODO: Upgrade to CDP via WebView2's CallDevToolsProtocolMethod for isTrusted=true events.
// For now, delegate to JS fallback which works for most scenarios.
// When upgrading, use:
//   webview.with_webview(|platform_wv| {
//       let controller = platform_wv.controller();
//       // controller -> ICoreWebView2 -> CallDevToolsProtocolMethod("Input.dispatchMouseEvent", ...)
//   });

/// Inject mouse events into the webview.
/// Currently uses JS fallback; will be upgraded to CDP for isTrusted events.
pub fn inject_mouse<R: Runtime>(
    webview: &Webview<R>,
    params: &MouseParams,
) -> Result<InputResult, Error> {
    js_fallback::inject_mouse_via_js(webview, params)
}

/// Inject text into the webview.
/// Currently uses JS fallback; will be upgraded to CDP for isTrusted events.
pub fn inject_text<R: Runtime>(
    webview: &Webview<R>,
    params: &TextParams,
) -> Result<TextResult, Error> {
    js_fallback::inject_text_via_js(webview, params)
}
