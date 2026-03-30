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
    let exists = state.labels.lock().unwrap().contains_key(&label);
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
            state.labels.lock().unwrap().remove(&label);
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

    // Inject window.teamclaw identity global before any page scripts run.
    if let (Some(ref dno), Some(ref dname)) = (&device_no, &device_name) {
        let escaped_no = serde_json::to_string(dno).unwrap_or_else(|_| "\"\"".to_string());
        let escaped_name = serde_json::to_string(dname).unwrap_or_else(|_| "\"\"".to_string());
        let script = format!(
            "Object.defineProperty(window, 'teamclaw', {{ value: Object.freeze({{ deviceNo: {}, deviceName: {} }}), writable: false, configurable: false }});",
            escaped_no, escaped_name,
        );
        webview_builder = webview_builder.initialization_script(&script);
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
    state.labels.lock().unwrap().insert(label.clone(), ());

    eprintln!("[Webview] Created successfully: {}", label);
    Ok(())
}

fn webview_close_inner(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, WebviewManager>,
    label: &str,
) {
    state.labels.lock().unwrap().remove(label);
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
