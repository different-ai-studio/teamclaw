use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Manager, Runtime};

/// Safari user agent matching the actual WKWebView engine.
/// Chrome UA causes blank pages — servers may return Chrome-specific responses
/// (e.g. Brotli encoding, different JS bundles) that WKWebView can't handle.
const WEBVIEW_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";
const EXTERNAL_WEBVIEW_INIT_SCRIPT: &str = r#"(function(){
  // Tauri notification plugin defines Notification.permission as readonly and throws
  // on direct assignment. Some external sites attempt this write and would otherwise
  // surface noisy unhandled rejections inside embedded webviews.
  function suppressReadonlyPermissionError(evt) {
    try {
      var reason = evt && evt.reason;
      var message = reason && reason.message ? String(reason.message) : String(reason || '');
      if (message !== 'Readonly property' && message !== 'Error: Readonly property') {
        return;
      }
      var stack = reason && reason.stack ? String(reason.stack) : '';
      if (stack && stack.indexOf('notification') === -1 && stack.indexOf('user-script') === -1) {
        return;
      }
      evt.preventDefault();
    } catch (_) {}
  }

  window.addEventListener('unhandledrejection', suppressReadonlyPermissionError, true);

  function installSafeNotificationWrapper() {
    try {
      if (!window.Notification) return;

      function wrapNotification(candidate) {
        if (typeof candidate !== 'function' || candidate.__TEAMCLAW_SAFE_NOTIFICATION__) {
          return candidate;
        }

        var permission = 'default';
        try {
          permission = candidate.permission == null ? 'default' : String(candidate.permission);
        } catch (_) {}

        function SafeNotification(title, options) {
          try {
            return new candidate(title, options);
          } catch (_) {
            return candidate.apply(this, arguments);
          }
        }

        try { SafeNotification.prototype = candidate.prototype; } catch (_) {}
        try {
          Object.getOwnPropertyNames(candidate).forEach(function(key) {
            if (key === 'permission' || key === 'prototype' || key === 'length' || key === 'name') {
              return;
            }
            try {
              Object.defineProperty(SafeNotification, key, Object.getOwnPropertyDescriptor(candidate, key));
            } catch (_) {}
          });
        } catch (_) {}

        Object.defineProperty(SafeNotification, 'permission', {
          enumerable: true,
          configurable: true,
          get: function() { return permission; },
          set: function(next) {
            permission = next == null ? 'default' : String(next);
            try { candidate.permission = next; } catch (_) {}
          }
        });
        Object.defineProperty(SafeNotification, '__TEAMCLAW_SAFE_NOTIFICATION__', {
          value: true,
          configurable: false
        });
        return SafeNotification;
      }

      var currentNotification = wrapNotification(window.Notification);
      Object.defineProperty(window, 'Notification', {
        enumerable: true,
        configurable: true,
        get: function() { return currentNotification; },
        set: function(next) { currentNotification = wrapNotification(next); }
      });
    } catch (_) {}
  }

  installSafeNotificationWrapper();

  function navigateHere(href) {
    try {
      window.top.location.href = href;
    } catch (_) {
      window.location.href = href;
    }
  }
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a) return;
    var t = a.getAttribute('target');
    if (t && t !== '_self') {
      var href = a.href || a.getAttribute('href');
      if (href && /^https?:\/\//.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        navigateHere(href);
      }
    }
  }, true);
  var _open = window.open;
  var _interceptOpen = function(url) {
    if (url && /^https?:\/\//.test(String(url))) {
      navigateHere(String(url));
      return window;
    }
    return _open.apply(this, arguments);
  };
  try {
    Object.defineProperty(window, 'open', {
      value: _interceptOpen, writable: true, configurable: true
    });
  } catch (_) {}
})();"#;

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
    pub labels: Mutex<HashMap<String, ()>>,
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

fn build_teamclaw_identity_script(
    device_no: &str,
    device_name: &str,
    device_token: Option<String>,
) -> String {
    let escaped_no = serde_json::to_string(device_no).unwrap_or_else(|_| "\"\"".to_string());
    let escaped_name = serde_json::to_string(device_name).unwrap_or_else(|_| "\"\"".to_string());
    let escaped_token = match device_token {
        Some(token) => serde_json::to_string(&token).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    };

    format!(
        r#"(function(){{
  var __next = {{ deviceNo: {no}, deviceName: {name}, deviceToken: {token} }};
  if (typeof window.__TEAMCLAW_SET_IDENTITY__ !== 'function') {{
    var __state = {{ deviceNo: '', deviceName: '', deviceToken: null }};
    Object.defineProperty(window, '__TEAMCLAW_SET_IDENTITY__', {{
      value: function(next) {{
        __state.deviceNo = next && next.deviceNo ? next.deviceNo : '';
        __state.deviceName = next && next.deviceName ? next.deviceName : '';
        __state.deviceToken = next ? next.deviceToken : null;
      }},
      writable: false,
      enumerable: false,
      configurable: true
    }});
    // Capture native Storage methods before any page script can monkey-patch them.
    // Pages that detect window.teamclaw sometimes wrap localStorage in a way that
    // breaks keys containing hyphens (e.g. "active-eruda"). Binding to
    // Storage.prototype here — at document start — preserves the original behaviour.
    var __nativeStorage;
    try {{
      var __si = Storage.prototype.setItem;
      var __gi = Storage.prototype.getItem;
      var __ri = Storage.prototype.removeItem;
      var __cl = Storage.prototype.clear;
      __nativeStorage = Object.freeze({{
        setItem:    function(k, v) {{ return __si.call(localStorage, k, v); }},
        getItem:    function(k)    {{ return __gi.call(localStorage, k);    }},
        removeItem: function(k)    {{ return __ri.call(localStorage, k);    }},
        clear:      function()     {{ return __cl.call(localStorage);       }},
      }});
    }} catch(_) {{
      __nativeStorage = null;
    }}
    Object.defineProperty(window, 'teamclaw', {{
      value: Object.freeze({{
        get deviceNo() {{ return __state.deviceNo; }},
        get deviceName() {{ return __state.deviceName; }},
        get deviceToken() {{ return __state.deviceToken; }},
        get nativeStorage() {{ return __nativeStorage; }},
      }}),
      writable: false,
      enumerable: true,
      configurable: true
    }});
  }}
  window.__TEAMCLAW_SET_IDENTITY__(__next);
}})();"#,
        no = escaped_no,
        name = escaped_name,
        token = escaped_token,
    )
}

fn build_teamclaw_identity_script_with_fresh_token(device_no: &str, device_name: &str) -> String {
    let device_token = match super::device_token::generate(device_no, "") {
        Ok(token) => Some(token),
        Err(e) => {
            eprintln!("[Webview] device_token generation skipped: {}", e);
            None
        }
    };
    build_teamclaw_identity_script(device_no, device_name, device_token)
}

#[cfg(target_os = "macos")]
fn add_document_start_script<R: Runtime>(webview: &tauri::Webview<R>, script: &str) {
    let script = script.to_string();
    if let Err(e) = webview.with_webview(move |wv| {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use std::ffi::CString;

        let Ok(script) = CString::new(script) else {
            return;
        };

        unsafe {
            let wk_webview: *const AnyObject = wv.inner().cast();
            let config: *const AnyObject = msg_send![wk_webview, configuration];
            if config.is_null() {
                return;
            }
            let controller: *const AnyObject = msg_send![config, userContentController];
            if controller.is_null() {
                return;
            }
            let source: *const AnyObject =
                msg_send![class!(NSString), stringWithUTF8String: script.as_ptr()];
            if source.is_null() {
                return;
            }
            let allocated: *mut AnyObject = msg_send![class!(WKUserScript), alloc];
            if allocated.is_null() {
                return;
            }
            let user_script: *mut AnyObject = msg_send![
                allocated,
                initWithSource: source,
                injectionTime: 0isize,
                forMainFrameOnly: true
            ];
            if user_script.is_null() {
                return;
            }
            let _: () = msg_send![controller, addUserScript: user_script];
            objc2::ffi::objc_release(user_script as *mut _);
        }
    }) {
        eprintln!("[Webview] Failed to refresh document-start identity script: {e}");
    }
}

#[cfg(not(target_os = "macos"))]
fn add_document_start_script<R: Runtime>(_webview: &tauri::Webview<R>, _script: &str) {}

/// Create a shared WKWebViewConfiguration on the main thread.
/// Must be called from Tauri's builder chain or setup() which run on the main thread.
///
/// All child webviews share this configuration, which means they share:
/// - WKProcessPool → session cookies shared in-memory across webviews
/// - WKWebsiteDataStore (defaultDataStore) → persistent cookies, localStorage shared
#[cfg(target_os = "macos")]
pub fn init_shared_config(manager: &mut WebviewManager) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, MainThreadMarker};
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

        // Keep Safari Web Inspector available in release builds too.
        // If this causes layout issues in specific scenarios, users can disable
        // it via TEAMCLAW_DISABLE_WEBVIEW_DEVTOOLS=1 when launching the app.
        let prefs = config.preferences();
        let prefs_ptr: *mut AnyObject = objc2::rc::Retained::as_ptr(&prefs) as *mut AnyObject;
        let disable_devtools = std::env::var("TEAMCLAW_DISABLE_WEBVIEW_DEVTOOLS")
            .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(false);
        let ns_bool: *mut AnyObject =
            msg_send![class!(NSNumber), numberWithBool: !disable_devtools];
        let key_str = std::ffi::CString::new("developerExtrasEnabled").unwrap();
        let key_ns: *mut AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: key_str.as_ptr()];
        let _: () = msg_send![prefs_ptr, setValue: ns_bool, forKey: key_ns];

        let raw = objc2::rc::Retained::as_ptr(&config) as *const std::ffi::c_void;
        objc2::ffi::objc_retain(raw as *mut _);
        manager.shared_config = Some(SharedConfig(raw));
    }
    eprintln!(
        "[Webview] Shared WKWebViewConfiguration initialized on main thread (defaultDataStore + shared pool, devtools enabled by default)"
    );
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

/// Create a native webview as a child of the calling window at the given position.
///
/// When `device_no` and `device_name` are provided, a `window.teamclaw` global
/// is injected into the webview before any page scripts run, exposing identity
/// information for the current team member.
#[tauri::command]
pub async fn webview_create(
    app: tauri::AppHandle,
    window: tauri::Window,
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

    let parsed_url = url
        .parse::<tauri::Url>()
        .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;

    eprintln!(
        "[Webview] Creating '{}' in parent '{}' url={} pos=({},{}) size={}x{}",
        label,
        window.label(),
        url,
        x,
        y,
        width,
        height
    );

    #[allow(unused_mut)]
    let mut webview_builder =
        tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url))
            .user_agent(WEBVIEW_UA);

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

    // Intercept target="_blank" links and window.open() so OAuth popups
    // remain in the same native webview. Run in all frames because OAuth
    // widgets often live inside iframes.
    webview_builder =
        webview_builder.initialization_script_for_all_frames(EXTERNAL_WEBVIEW_INIT_SCRIPT);

    // Native fallback for popup requests that bypass our JS hook.
    {
        let popup_label = label.clone();
        let popup_app = app.clone();
        webview_builder = webview_builder.on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                eprintln!(
                    "[Webview] Redirecting popup request for '{}' to {}",
                    popup_label, url
                );
                if let Some(webview) = popup_app.get_webview(&popup_label) {
                    let _ = webview.navigate(url.clone());
                }
            }
            tauri::webview::NewWindowResponse::Deny
        });
    }

    // Inject as long as we have a device ID. Device name is a display-only
    // string — empty is fine and must not block the JWT/storage shim.
    let identity = device_no
        .as_deref()
        .filter(|dno| !dno.is_empty())
        .map(|dno| (dno.to_string(), device_name.clone().unwrap_or_default()));
    let initial_identity_script = identity
        .as_ref()
        .map(|(dno, dname)| build_teamclaw_identity_script_with_fresh_token(dno, dname));

    // Page load progress via on_page_load callback (no JS injection needed —
    // child webviews don't have __TAURI_INTERNALS__)
    {
        let progress_label = label.clone();
        let identity = identity.clone();
        webview_builder = webview_builder.on_page_load(move |webview, payload| {
            use tauri::Emitter;
            let progress = match payload.event() {
                tauri::webview::PageLoadEvent::Started => 30,
                tauri::webview::PageLoadEvent::Finished => 100,
            };
            let _ = webview.emit(
                "webview-progress",
                serde_json::json!({
                    "label": progress_label,
                    "progress": progress
                }),
            );

            if let Some((device_no, device_name)) = &identity {
                let script =
                    build_teamclaw_identity_script_with_fresh_token(device_no, device_name);
                match payload.event() {
                    tauri::webview::PageLoadEvent::Started => {
                        add_document_start_script(&webview, &script);
                    }
                    tauri::webview::PageLoadEvent::Finished => {
                        let _ = webview.eval(&script);
                    }
                }
            }
        });
    }

    // Right-click: rely on the native WKWebView / WebView2 context menu.
    // No custom init script needed — native menus provide Copy/Paste/Look Up/etc.

    // Inject window.teamclaw before page scripts run. The object is stable but
    // its getters read refreshed values after OAuth redirects and page reloads.
    if let Some(script) = initial_identity_script {
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

/// Get the page title of a child webview via native platform API.
/// Child webviews loading external URLs don't have __TAURI_INTERNALS__,
/// so we read the title directly from the native WKWebView / WebView2.
#[tauri::command]
pub async fn webview_get_title(app: tauri::AppHandle, label: String) -> Result<String, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let (tx, rx) = std::sync::mpsc::channel::<String>();

    webview
        .with_webview(move |wv| {
            #[cfg(target_os = "macos")]
            {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                unsafe {
                    let wk_webview: *const AnyObject = wv.inner().cast();
                    let ns_title: *const AnyObject = msg_send![wk_webview, title];
                    if !ns_title.is_null() {
                        let utf8: *const std::ffi::c_char = msg_send![ns_title, UTF8String];
                        if !utf8.is_null() {
                            let s = std::ffi::CStr::from_ptr(utf8).to_string_lossy().to_string();
                            let _ = tx.send(s);
                            return;
                        }
                    }
                }
                let _ = tx.send(String::new());
            }
            #[cfg(target_os = "windows")]
            {
                // WebView2: access ICoreWebView2 DocumentTitle via with_webview
                // For now, return empty — will be improved when testing on Windows
                let _ = wv; // suppress unused warning
                let _ = tx.send(String::new());
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let _ = wv;
                let _ = tx.send(String::new());
            }
        })
        .map_err(|e| e.to_string())?;

    // with_webview dispatches to the main thread, wait for result
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(title) => Ok(title),
        Err(_) => Ok(String::new()),
    }
}

/// Get the favicon URL for a child webview.
/// Derives from the webview's current URL origin — no JS eval needed
/// since child webviews don't have __TAURI_INTERNALS__.
#[tauri::command]
pub async fn webview_get_favicon(app: tauri::AppHandle, label: String) -> Result<String, String> {
    if let Some(webview) = app.get_webview(&label) {
        let url = webview.url().map_err(|e| format!("{}", e))?;
        if let Some(host) = url.host_str() {
            let scheme = url.scheme();
            let port = url.port().map(|p| format!(":{}", p)).unwrap_or_default();
            return Ok(format!("{}://{}{}/favicon.ico", scheme, host, port));
        }
    }
    Ok(String::new())
}

/// Find text in a child webview page.
/// Fire-and-forget: window.find() highlights matches visually.
/// Returns true always (we can't get the result back from external webviews
/// since __TAURI_INTERNALS__ is not available).
#[tauri::command]
pub async fn webview_find_in_page(
    app: tauri::AppHandle,
    label: String,
    query: String,
    forward: bool,
) -> Result<bool, String> {
    if let Some(webview) = app.get_webview(&label) {
        let escaped_query = serde_json::to_string(&query).unwrap_or_else(|_| "\"\"".to_string());
        let backward = if forward { "false" } else { "true" };
        let js = format!(
            "window.find({}, false, {}, true, false, false, false)",
            escaped_query, backward
        );
        webview
            .eval(&js)
            .map_err(|e| format!("Failed to eval: {}", e))?;
    }
    // Can't get result back from external webview, assume found
    Ok(true)
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

// Context menu: using native WKWebView / WebView2 built-in context menu.
// No custom Rust handler needed — the native menu provides Copy/Paste/Look Up/etc.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teamclaw_identity_script_is_refreshable() {
        let script =
            build_teamclaw_identity_script("device-1", "Alice", Some("token-1".to_string()));

        assert!(script.contains("__TEAMCLAW_SET_IDENTITY__"));
        assert!(script.contains("get deviceToken()"));
        assert!(script.contains("configurable: true"));
        assert!(script.contains("\"device-1\""));
        assert!(script.contains("\"Alice\""));
        assert!(script.contains("\"token-1\""));
    }

    #[test]
    fn teamclaw_identity_script_escapes_values_and_allows_missing_token() {
        let script = build_teamclaw_identity_script("device\"quoted", "name\nline", None);

        assert!(script.contains("device\\\"quoted"));
        assert!(script.contains("name\\nline"));
        assert!(script.contains("deviceToken: null"));
    }

    #[test]
    fn external_webview_init_script_suppresses_notification_readonly_rejection() {
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("unhandledrejection"));
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("Readonly property"));
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("evt.preventDefault()"));
    }

    #[test]
    fn external_webview_init_script_wraps_notification_permission_setter() {
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("__TEAMCLAW_SAFE_NOTIFICATION__"));
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("function SafeNotification"));
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("set: function(next)"));
    }
}
