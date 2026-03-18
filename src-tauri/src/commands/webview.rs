use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

/// Chrome-like user agent so websites serve normal desktop content.
const CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// State to track child webview labels.
pub struct WebviewManager {
    labels: Mutex<HashMap<String, ()>>,
}

impl Default for WebviewManager {
    fn default() -> Self {
        Self {
            labels: Mutex::new(HashMap::new()),
        }
    }
}

/// Create a native webview as a child of the main window at the given position.
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
) -> Result<(), String> {
    // If webview with this label already exists, just show and reposition it
    let exists = state.labels.lock().unwrap().contains_key(&label);
    if exists {
        if let Some(webview) = app.get_webview(&label) {
            eprintln!("[Webview] Reusing existing '{}', showing and repositioning", label);
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

    let webview_builder = tauri::webview::WebviewBuilder::new(
        &label,
        tauri::WebviewUrl::External(parsed_url),
    )
    .user_agent(CHROME_UA);

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

/// Get the current URL of the webview.
#[tauri::command]
pub async fn webview_get_url(app: tauri::AppHandle, label: String) -> Result<String, String> {
    if let Some(webview) = app.get_webview(&label) {
        return webview.url().map(|u| u.to_string()).map_err(|e| format!("{}", e));
    }
    Err("Webview not found".to_string())
}
