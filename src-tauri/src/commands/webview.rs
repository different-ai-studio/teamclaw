use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

/// Chrome-like user agent so websites serve normal desktop content.
const CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Send-safe wrapper around a retained ObjC WKWebViewConfiguration pointer.
#[cfg(target_os = "macos")]
pub struct SharedConfig(*const std::ffi::c_void);
#[cfg(target_os = "macos")]
unsafe impl Send for SharedConfig {}
#[cfg(target_os = "macos")]
unsafe impl Sync for SharedConfig {}

#[cfg(target_os = "macos")]
impl Drop for SharedConfig {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { objc2::ffi::objc_release(self.0 as *mut _) };
        }
    }
}

/// State to track child webview labels.
pub struct WebviewManager {
    labels: Mutex<HashMap<String, ()>>,
    /// Shared WKWebViewConfiguration so all external webviews share the same
    /// WKProcessPool (in-memory cookies) and WKWebsiteDataStore (persistent cookies).
    #[cfg(target_os = "macos")]
    pub shared_config: Option<SharedConfig>,
}

impl Default for WebviewManager {
    fn default() -> Self {
        Self {
            labels: Mutex::new(HashMap::new()),
            #[cfg(target_os = "macos")]
            shared_config: None,
        }
    }
}

/// Create a shared WKWebViewConfiguration on the main thread.
/// Must be called from Tauri's builder chain or setup() which run on the main thread.
///
/// All child webviews share this configuration, which means they share:
/// - WKProcessPool → session cookies shared in-memory across webviews
/// - WKWebsiteDataStore (defaultDataStore) → persistent cookies, localStorage shared
#[cfg(target_os = "macos")]
pub fn init_shared_config(manager: &mut WebviewManager) {
    use objc2::MainThreadMarker;
    use objc2_web_kit::{WKWebViewConfiguration, WKWebsiteDataStore};

    let mtm =
        MainThreadMarker::new().expect("init_shared_config must be called from the main thread");
    unsafe {
        let config = WKWebViewConfiguration::new(mtm);
        // Explicitly set the default persistent data store so cookies/localStorage
        // are shared with all webviews using this config.
        // Note: WKProcessPool is deprecated/no-op on modern macOS — all webviews
        // share a single global process pool automatically.
        let data_store = WKWebsiteDataStore::defaultDataStore(mtm);
        config.setWebsiteDataStore(&data_store);
        let raw = objc2::rc::Retained::as_ptr(&config) as *const std::ffi::c_void;
        objc2::ffi::objc_retain(raw as *mut _);
        manager.shared_config = Some(SharedConfig(raw));
    }
    eprintln!("[Webview] Shared WKWebViewConfiguration initialized on main thread (defaultDataStore + shared pool)");
}

/// Execute JavaScript in the main webview and return the stringified result.
/// Debug-only: used by stress tests and automation via tauri-mcp socket.
///
/// The JS code is eval'd, the result is stringified and sent back via Tauri event.
/// Rust listens for the event with a 10-second timeout.
#[tauri::command]
pub async fn webview_eval_js(app: tauri::AppHandle, code: String) -> Result<String, String> {
    use tauri::Listener;

    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    // Generate a unique callback ID to avoid collisions
    let callback_id = format!(
        "__eval_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );

    // Wrap the code: eval it, stringify the result, store in a global keyed by callback_id
    // Then call postMessage to the IPC channel to signal completion.
    let escaped_code = serde_json::to_string(&code).unwrap_or_else(|_| "\"\"".to_string());
    let escaped_id = serde_json::to_string(&callback_id).unwrap_or_else(|_| "\"\"".to_string());
    let wrapped = format!(
        r#"try {{
    const __r = (0, eval)({code});
    const __s = typeof __r === 'object' ? JSON.stringify(__r) : String(__r);
    window.__TAURI_INTERNALS__.postMessage(JSON.stringify({{
        cmd: "plugin:event|emit",
        event: {id},
        payload: JSON.stringify({{ result: __s }})
    }}));
}} catch (__e) {{
    window.__TAURI_INTERNALS__.postMessage(JSON.stringify({{
        cmd: "plugin:event|emit",
        event: {id},
        payload: JSON.stringify({{ error: String(__e) }})
    }}));
}}"#,
        code = escaped_code,
        id = escaped_id,
    );

    // Set up receiver
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    app.once(&callback_id, move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    // Execute
    webview
        .eval(&wrapped)
        .map_err(|e| format!("Failed to eval: {}", e))?;

    // Wait for result
    match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(raw) => {
            // Parse the double-serialized payload
            let payload_str: String = serde_json::from_str(&raw).unwrap_or(raw.clone());
            let parsed: serde_json::Value =
                serde_json::from_str(&payload_str).unwrap_or(serde_json::Value::String(raw));
            if let Some(err) = parsed.get("error").and_then(|e| e.as_str()) {
                return Err(format!("JS error: {}", err));
            }
            Ok(parsed
                .get("result")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string())
        }
        Err(_) => Err("Timeout waiting for JS eval result (10s)".to_string()),
    }
}

/// Create a native webview as a child of the main window at the given position.
///
/// When `device_no` and `device_name` are provided, a `window.teamclaw` global
/// is injected into the webview before any page scripts run, exposing identity
/// information for the current team member.
#[tauri::command]
pub async fn webview_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, WebviewManager>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    device_no: Option<String>,
    device_name: Option<String>,
) -> Result<(), String> {
    // If webview with this label already exists, just show and reposition it
    let exists = state
        .labels
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&label);
    if exists {
        if let Some(webview) = app.get_webview(&label) {
            eprintln!(
                "[Webview] Reusing existing '{}', showing and repositioning",
                label
            );
            let _ = webview.set_position(tauri::LogicalPosition::new(x, y));
            let _ = webview.set_size(tauri::LogicalSize::new(width, height));
            let _ = webview.show();
            let _ = webview.set_focus();
            return Ok(());
        } else {
            // Label tracked but webview gone — clean up
            state
                .labels
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&label);
        }
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let parsed_url = url
        .parse::<tauri::Url>()
        .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;

    eprintln!(
        "[Webview] Creating '{}' url={} pos=({},{}) size={}x{}",
        label, url, x, y, width, height
    );

    #[allow(unused_mut)]
    let mut webview_builder =
        tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url))
            .user_agent(CHROME_UA);

    // On macOS, use the shared WKWebViewConfiguration so all webviews share
    // the same WKProcessPool → cookies/session shared instantly across tabs.
    #[cfg(target_os = "macos")]
    if let Some(ref shared) = state.shared_config {
        unsafe {
            use objc2::rc::Retained;
            use objc2_web_kit::WKWebViewConfiguration;

            let config_ptr = shared.0 as *mut WKWebViewConfiguration;
            let config: Retained<WKWebViewConfiguration> = Retained::retain(config_ptr)
                .expect("Shared WKWebViewConfiguration should be valid");
            webview_builder = webview_builder.with_webview_configuration(config);
            eprintln!("[Webview] Using shared WKWebViewConfiguration");
        }
    }

    // Intercept target="_blank" links and window.open() so they navigate
    // within the same webview instead of opening the system browser.
    webview_builder = webview_builder.initialization_script(
        r#"(function(){
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a) return;
    var t = a.getAttribute('target');
    if (t && t !== '_self') {
      var href = a.href || a.getAttribute('href');
      if (href && /^https?:\/\//.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = href;
      }
    }
  }, true);
  var _open = window.open;
  window.open = function(url) {
    if (url && /^https?:\/\//.test(String(url))) {
      window.location.href = String(url);
      return window;
    }
    return _open.apply(this, arguments);
  };
})();"#,
    );

    // Report page load progress via Tauri events
    let label_json = serde_json::to_string(&label).unwrap_or_else(|_| "\"\"".to_string());
    webview_builder = webview_builder.initialization_script(&format!(
        r#"(function(){{
  var __label = {label_json};
  function __reportProgress(p) {{
    try {{
      window.__TAURI_INTERNALS__.postMessage(JSON.stringify({{
        cmd: "plugin:event|emit",
        event: "webview-progress",
        payload: JSON.stringify({{ label: __label, progress: p }})
      }}));
    }} catch(e) {{}}
  }}
  if (document.readyState === 'loading') {{
    __reportProgress(30);
    document.addEventListener('DOMContentLoaded', function() {{ __reportProgress(70); }});
    window.addEventListener('load', function() {{ __reportProgress(100); }});
  }} else if (document.readyState === 'interactive') {{
    __reportProgress(70);
    window.addEventListener('load', function() {{ __reportProgress(100); }});
  }} else {{
    __reportProgress(100);
  }}
  var __origPush = history.pushState;
  var __origReplace = history.replaceState;
  function __onNav() {{
    __reportProgress(30);
    setTimeout(function() {{ __reportProgress(100); }}, 500);
  }}
  history.pushState = function() {{ __origPush.apply(this, arguments); __onNav(); }};
  history.replaceState = function() {{ __origReplace.apply(this, arguments); __onNav(); }};
  window.addEventListener('popstate', __onNav);
}})()"#,
        label_json = label_json,
    ));

    // Right-click context menu: collect context and send to Rust
    webview_builder = webview_builder.initialization_script(&format!(
        r#"(function(){{
  var __label = {label_json};
  document.addEventListener('contextmenu', function(e) {{
    var ctx = {{ label: __label, selectedText: '', linkUrl: '', linkText: '', x: e.clientX, y: e.clientY }};
    var sel = window.getSelection();
    if (sel && sel.toString().trim()) ctx.selectedText = sel.toString().trim();
    var a = e.target.closest && e.target.closest('a');
    if (a && a.href) {{ ctx.linkUrl = a.href; ctx.linkText = a.textContent || ''; }}
    e.preventDefault();
    try {{
      window.__TAURI_INTERNALS__.postMessage(JSON.stringify({{
        cmd: "plugin:event|emit",
        event: "webview-context-menu",
        payload: JSON.stringify(ctx)
      }}));
    }} catch(ex) {{}}
  }}, true);
}})()"#,
        label_json = label_json,
    ));

    // Inject window.teamclaw identity global before any page scripts run.
    // Non-fatal: if device_token generation fails (e.g. DEVICE_JWT_SECRET not configured),
    // the webview still loads — just without the identity global.
    if let (Some(ref dno), Some(ref dname)) = (&device_no, &device_name) {
        match super::device_token::generate(dno, "") {
            Ok(device_token) => {
                let escaped_no =
                    serde_json::to_string(dno).unwrap_or_else(|_| "\"\"".to_string());
                let escaped_name =
                    serde_json::to_string(dname).unwrap_or_else(|_| "\"\"".to_string());
                let escaped_token =
                    serde_json::to_string(&device_token).unwrap_or_else(|_| "\"\"".to_string());
                let script = format!(
                    "Object.defineProperty(window, 'teamclaw', {{ value: Object.freeze({{ deviceNo: {no}, deviceName: {name}, deviceToken: {token} }}), writable: false, configurable: false }});",
                    no = escaped_no,
                    name = escaped_name,
                    token = escaped_token,
                );
                webview_builder = webview_builder.initialization_script(&script);
            }
            Err(e) => {
                eprintln!("[Webview] Skipping device_token injection: {}", e);
            }
        }
    }

    let webview = window
        .add_child(
            webview_builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create webview: {}", e))?;

    // Bring the child webview to front
    let _ = webview.set_focus();

    // Track the label
    state
        .labels
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label.clone(), ());

    eprintln!("[Webview] Created successfully: {}", label);
    Ok(())
}

fn webview_close_inner(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, WebviewManager>,
    label: &str,
) {
    state
        .labels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(label);
    if let Some(webview) = app.get_webview(label) {
        let _ = webview.close();
    }
}

/// Close a native webview by label (destroys it).
#[tauri::command]
pub async fn webview_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, WebviewManager>,
    label: String,
) -> Result<(), String> {
    eprintln!("[Webview] Closing: {}", label);
    webview_close_inner(&app, &state, &label);
    Ok(())
}

/// Hide a native webview (keeps it alive, no reload on show).
#[tauri::command]
pub async fn webview_hide(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        eprintln!("[Webview] Hiding: {}", label);
        let _ = webview.hide();
    }
    Ok(())
}

/// Show a hidden native webview and bring it to front.
#[tauri::command]
pub async fn webview_show(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        eprintln!("[Webview] Showing: {}", label);
        let _ = webview.set_position(tauri::LogicalPosition::new(x, y));
        let _ = webview.set_size(tauri::LogicalSize::new(width, height));
        let _ = webview.show();
        let _ = webview.set_focus();
    }
    Ok(())
}

/// Resize and reposition a native webview.
#[tauri::command]
pub async fn webview_set_bounds(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.set_position(tauri::LogicalPosition::new(x, y));
        let _ = webview.set_size(tauri::LogicalSize::new(width, height));
    }
    Ok(())
}

/// Bring a native webview to front.
#[tauri::command]
pub async fn webview_focus(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.set_focus();
    }
    Ok(())
}

/// Navigate back in the webview history.
#[tauri::command]
pub async fn webview_go_back(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.eval("window.history.back()");
    }
    Ok(())
}

/// Navigate forward in the webview history.
#[tauri::command]
pub async fn webview_go_forward(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.eval("window.history.forward()");
    }
    Ok(())
}

/// Reload the webview.
#[tauri::command]
pub async fn webview_reload(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.eval("window.location.reload()");
    }
    Ok(())
}

/// Navigate a webview to a new URL.
#[tauri::command]
pub async fn webview_navigate(
    app: tauri::AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let parsed = url
            .parse::<tauri::Url>()
            .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
        eprintln!("[Webview] Navigating '{}' to {}", label, url);
        webview
            .navigate(parsed)
            .map_err(|e| format!("Failed to navigate: {}", e))?;
    }
    Ok(())
}

/// Get the current URL of the webview.
#[tauri::command]
pub async fn webview_get_url(app: tauri::AppHandle, label: String) -> Result<String, String> {
    if let Some(webview) = app.get_webview(&label) {
        return webview
            .url()
            .map(|u| u.to_string())
            .map_err(|e| format!("{}", e));
    }
    Err("Webview not found".to_string())
}

/// Get the page title of a child webview.
#[tauri::command]
pub async fn webview_get_title(app: tauri::AppHandle, label: String) -> Result<String, String> {
    use tauri::Listener;

    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let callback_id = format!(
        "__title_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );

    let escaped_id = serde_json::to_string(&callback_id).unwrap_or_else(|_| "\"\"".to_string());
    let wrapped = format!(
        r#"try {{
    const __r = document.title || '';
    window.__TAURI_INTERNALS__.postMessage(JSON.stringify({{
        cmd: "plugin:event|emit",
        event: {id},
        payload: JSON.stringify({{ result: __r }})
    }}));
}} catch (__e) {{
    window.__TAURI_INTERNALS__.postMessage(JSON.stringify({{
        cmd: "plugin:event|emit",
        event: {id},
        payload: JSON.stringify({{ result: '' }})
    }}));
}}"#,
        id = escaped_id,
    );

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    app.once(&callback_id, move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    webview
        .eval(&wrapped)
        .map_err(|e| format!("Failed to eval: {}", e))?;

    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(raw) => {
            let payload_str: String = serde_json::from_str(&raw).unwrap_or(raw.clone());
            let parsed: serde_json::Value =
                serde_json::from_str(&payload_str).unwrap_or(serde_json::Value::String(raw));
            Ok(parsed
                .get("result")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string())
        }
        Err(_) => Ok(String::new()),
    }
}

/// Get the favicon URL of a child webview.
#[tauri::command]
pub async fn webview_get_favicon(app: tauri::AppHandle, label: String) -> Result<String, String> {
    use tauri::Listener;

    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let callback_id = format!(
        "__favicon_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );

    let escaped_id = serde_json::to_string(&callback_id).unwrap_or_else(|_| "\"\"".to_string());
    let wrapped = format!(
        r#"try {{
    const __el = document.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel*="icon"]');
    const __r = __el ? __el.href : (location.origin + '/favicon.ico');
    window.__TAURI_INTERNALS__.postMessage(JSON.stringify({{
        cmd: "plugin:event|emit",
        event: {id},
        payload: JSON.stringify({{ result: __r }})
    }}));
}} catch (__e) {{
    window.__TAURI_INTERNALS__.postMessage(JSON.stringify({{
        cmd: "plugin:event|emit",
        event: {id},
        payload: JSON.stringify({{ result: '' }})
    }}));
}}"#,
        id = escaped_id,
    );

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    app.once(&callback_id, move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    webview
        .eval(&wrapped)
        .map_err(|e| format!("Failed to eval: {}", e))?;

    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(raw) => {
            let payload_str: String = serde_json::from_str(&raw).unwrap_or(raw.clone());
            let parsed: serde_json::Value =
                serde_json::from_str(&payload_str).unwrap_or(serde_json::Value::String(raw));
            Ok(parsed
                .get("result")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string())
        }
        Err(_) => Ok(String::new()),
    }
}

/// Find text in a child webview page. Returns whether a match was found.
#[tauri::command]
pub async fn webview_find_in_page(
    app: tauri::AppHandle,
    label: String,
    query: String,
    forward: bool,
) -> Result<bool, String> {
    use tauri::Listener;

    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let callback_id = format!(
        "__find_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );

    let escaped_id = serde_json::to_string(&callback_id).unwrap_or_else(|_| "\"\"".to_string());
    let escaped_query = serde_json::to_string(&query).unwrap_or_else(|_| "\"\"".to_string());
    let backward = if forward { "false" } else { "true" };
    let wrapped = format!(
        r#"try {{
    const __r = window.find({query}, false, {backward}, true, false, false, false);
    window.__TAURI_INTERNALS__.postMessage(JSON.stringify({{
        cmd: "plugin:event|emit",
        event: {id},
        payload: JSON.stringify({{ result: String(__r) }})
    }}));
}} catch (__e) {{
    window.__TAURI_INTERNALS__.postMessage(JSON.stringify({{
        cmd: "plugin:event|emit",
        event: {id},
        payload: JSON.stringify({{ result: 'false' }})
    }}));
}}"#,
        query = escaped_query,
        backward = backward,
        id = escaped_id,
    );

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    app.once(&callback_id, move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    webview
        .eval(&wrapped)
        .map_err(|e| format!("Failed to eval: {}", e))?;

    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(raw) => {
            let payload_str: String = serde_json::from_str(&raw).unwrap_or(raw.clone());
            let parsed: serde_json::Value =
                serde_json::from_str(&payload_str).unwrap_or(serde_json::Value::String(raw));
            let result_str = parsed
                .get("result")
                .and_then(|r| r.as_str())
                .unwrap_or("false");
            Ok(result_str == "true")
        }
        Err(_) => Ok(false),
    }
}

/// Clear find-in-page highlights in a child webview.
#[tauri::command]
pub async fn webview_clear_find(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.eval("window.getSelection().removeAllRanges()");
    }
    Ok(())
}

/// Set the zoom level of a child webview.
#[tauri::command]
pub async fn webview_set_zoom(
    app: tauri::AppHandle,
    label: String,
    level: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.eval(&format!("document.body.style.zoom = '{}'", level));
    }
    Ok(())
}

/// Show a native context menu for the webview.
#[tauri::command]
pub async fn webview_show_context_menu(
    app: tauri::AppHandle,
    label: String,
    selected_text: String,
    link_url: String,
    _x: f64,
    _y: f64,
) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};

    let window = app
        .get_window("main")
        .ok_or("Main window not found")?;

    let mut builder = MenuBuilder::new(&app);

    if !selected_text.is_empty() {
        let copy_item = MenuItemBuilder::with_id("ctx_copy", "Copy")
            .build(&app)
            .map_err(|e| e.to_string())?;
        builder = builder.item(&copy_item);
    }

    let paste_item = MenuItemBuilder::with_id("ctx_paste", "Paste")
        .build(&app)
        .map_err(|e| e.to_string())?;
    builder = builder.item(&paste_item);

    let select_all_item = MenuItemBuilder::with_id("ctx_select_all", "Select All")
        .build(&app)
        .map_err(|e| e.to_string())?;
    builder = builder.item(&select_all_item);

    if !link_url.is_empty() {
        let sep = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
        builder = builder.item(&sep);
        let copy_link_item = MenuItemBuilder::with_id("ctx_copy_link", "Copy Link Address")
            .build(&app)
            .map_err(|e| e.to_string())?;
        builder = builder.item(&copy_link_item);
    }

    let menu = builder.build().map_err(|e| e.to_string())?;

    let label_clone = label.clone();
    let link_url_clone = link_url.clone();
    let app_clone = app.clone();

    window.on_menu_event(move |_window, event| {
        let id = event.id.as_ref();
        let wv = app_clone.get_webview(&label_clone);
        match id {
            "ctx_copy" => {
                if let Some(ref wv) = wv {
                    let _ = wv.eval("document.execCommand('copy')");
                }
            }
            "ctx_paste" => {
                if let Some(ref wv) = wv {
                    let _ = wv.eval("document.execCommand('paste')");
                }
            }
            "ctx_select_all" => {
                if let Some(ref wv) = wv {
                    let _ = wv.eval("document.execCommand('selectAll')");
                }
            }
            "ctx_copy_link" => {
                if let Ok(mut clipboard) = arboard::Clipboard::new() {
                    let _ = clipboard.set_text(&link_url_clone);
                }
            }
            _ => {}
        }
    });

    window
        .popup_menu(&menu)
        .map_err(|e| e.to_string())?;

    Ok(())
}
