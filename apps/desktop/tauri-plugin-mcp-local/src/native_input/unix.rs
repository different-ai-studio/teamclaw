use tauri::{Runtime, Webview};

use crate::error::Error;
use super::{InputResult, MouseParams, TextParams, TextResult};
use super::js_fallback;

// TODO: Future upgrade path — inject GdkEvent directly into the WebKitWebView
// via with_webview(|platform_wv| { platform_wv.inner() /* webkit2gtk::WebView */ }).

/// Inject mouse events into the webview via JS fallback.
pub fn inject_mouse<R: Runtime>(
    webview: &Webview<R>,
    params: &MouseParams,
) -> Result<InputResult, Error> {
    js_fallback::inject_mouse_via_js(webview, params)
}

/// Inject text into the webview via JS fallback.
pub fn inject_text<R: Runtime>(
    webview: &Webview<R>,
    params: &TextParams,
) -> Result<TextResult, Error> {
    js_fallback::inject_text_via_js(webview, params)
}
