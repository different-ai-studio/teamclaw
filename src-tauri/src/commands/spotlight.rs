use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State};

// --- Constants ---

const SPOTLIGHT_WIDTH: f64 = 420.0;
const SPOTLIGHT_HEIGHT: f64 = 560.0;
const MAIN_WIDTH: f64 = 1200.0;
const MAIN_HEIGHT: f64 = 800.0;
const MARGIN: f64 = 20.0;

// --- macOS traffic light helpers ---

/// Hide the native traffic light buttons (close/minimize/zoom).
#[cfg(target_os = "macos")]
fn hide_traffic_lights(win: &tauri::WebviewWindow) {
    use cocoa::appkit::{NSWindow, NSWindowButton};
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};

    if let Ok(ns_window) = win.ns_window() {
        let ns_window = ns_window as id;
        unsafe {
            let close = ns_window.standardWindowButton_(NSWindowButton::NSWindowCloseButton);
            let miniaturize =
                ns_window.standardWindowButton_(NSWindowButton::NSWindowMiniaturizeButton);
            let zoom = ns_window.standardWindowButton_(NSWindowButton::NSWindowZoomButton);
            let _: () = msg_send![close, setHidden: true];
            let _: () = msg_send![miniaturize, setHidden: true];
            let _: () = msg_send![zoom, setHidden: true];
        }
    }
}

/// Set NSWindow alpha value (0.0 = transparent, 1.0 = opaque).
#[cfg(target_os = "macos")]
fn set_window_alpha(win: &tauri::WebviewWindow, alpha: f64) {
    use cocoa::appkit::NSWindow;
    use cocoa::base::id;
    if let Ok(ns_win) = win.ns_window() {
        unsafe { (ns_win as id).setAlphaValue_(alpha) };
    }
}

/// Reposition macOS traffic light buttons (close/minimize/zoom).
/// Moves them down and right from default position to align with the app header.
///
/// Uses saved original positions so calling this multiple times is idempotent
/// (no cumulative offset drift).
#[cfg(target_os = "macos")]
pub fn reposition_traffic_lights(win: &tauri::WebviewWindow) {
    use cocoa::appkit::{NSWindow, NSWindowButton};
    use cocoa::base::id;
    use cocoa::foundation::NSPoint;
    use objc::{msg_send, sel, sel_impl};

    // Offset from default: +10px right, +10px down
    const OFFSET_X: f64 = 10.0;
    const OFFSET_Y: f64 = 10.0;

    /// Original (default) positions of traffic light buttons, saved on first call.
    static ORIGINAL_ORIGINS: OnceLock<[(f64, f64); 3]> = OnceLock::new();

    if let Ok(ns_window) = win.ns_window() {
        let ns_window = ns_window as id;
        unsafe {
            let buttons = [
                ns_window.standardWindowButton_(NSWindowButton::NSWindowCloseButton),
                ns_window.standardWindowButton_(NSWindowButton::NSWindowMiniaturizeButton),
                ns_window.standardWindowButton_(NSWindowButton::NSWindowZoomButton),
            ];

            // Save original positions on first call (before any offset is applied)
            let origins = ORIGINAL_ORIGINS.get_or_init(|| {
                let mut result = [(0.0, 0.0); 3];
                for (i, btn) in buttons.iter().enumerate() {
                    let frame: cocoa::foundation::NSRect = msg_send![*btn, frame];
                    result[i] = (frame.origin.x, frame.origin.y);
                }
                result
            });

            // Always set position from saved originals — no accumulation
            for (i, btn) in buttons.iter().enumerate() {
                let (orig_x, orig_y) = origins[i];
                let new_origin = NSPoint::new(orig_x + OFFSET_X, orig_y - OFFSET_Y);
                let _: () = msg_send![*btn, setFrameOrigin: new_origin];
            }
        }
    }
}

/// Show the native traffic light buttons and reposition them.
#[cfg(target_os = "macos")]
fn show_traffic_lights(win: &tauri::WebviewWindow) {
    use cocoa::appkit::{NSWindow, NSWindowButton};
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};

    if let Ok(ns_window) = win.ns_window() {
        let ns_window = ns_window as id;
        unsafe {
            let close = ns_window.standardWindowButton_(NSWindowButton::NSWindowCloseButton);
            let miniaturize =
                ns_window.standardWindowButton_(NSWindowButton::NSWindowMiniaturizeButton);
            let zoom = ns_window.standardWindowButton_(NSWindowButton::NSWindowZoomButton);
            let _: () = msg_send![close, setHidden: false];
            let _: () = msg_send![miniaturize, setHidden: false];
            let _: () = msg_send![zoom, setHidden: false];
        }
    }
    reposition_traffic_lights(win);
}

// --- Types ---

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WindowMode {
    Spotlight,
    Main,
}

pub struct SpotlightState {
    /// Current window mode.
    pub mode: Mutex<WindowMode>,
    /// Whether the spotlight window should be always-on-top (pinned).
    pub pinned: Mutex<bool>,
    /// Stored spotlight position as logical coordinates (scale-independent).
    pub spotlight_position: Mutex<Option<(f64, f64)>>,
    /// Stored main window geometry: (x, y, width, height) in logical coordinates.
    pub main_geometry: Mutex<Option<(f64, f64, f64, f64)>>,
}

impl Default for SpotlightState {
    fn default() -> Self {
        Self {
            mode: Mutex::new(WindowMode::Main),
            pinned: Mutex::new(false),
            spotlight_position: Mutex::new(None),
            main_geometry: Mutex::new(None),
        }
    }
}

// --- Helper Functions ---

/// Save the current position of the window as the spotlight position (physical -> logical).
fn save_spotlight_position(win: &tauri::WebviewWindow, state: &SpotlightState) {
    if let Ok(pos) = win.outer_position() {
        let scale = win
            .current_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0);
        let mut last_pos = state.spotlight_position.lock().unwrap_or_else(|e| e.into_inner());
        *last_pos = Some((pos.x as f64 / scale, pos.y as f64 / scale));
    }
}

/// Get the default spotlight position: top-right of the current monitor.
fn default_spotlight_position(win: &tauri::WebviewWindow) -> (f64, f64) {
    if let Some(monitor) = win.current_monitor().ok().flatten() {
        let screen = monitor.size();
        let scale = monitor.scale_factor();
        let x = (screen.width as f64 / scale) - SPOTLIGHT_WIDTH - MARGIN;
        let y = MARGIN;
        (x, y)
    } else {
        // Fallback
        (MARGIN, MARGIN)
    }
}

/// Restore the saved spotlight position, or default to top-right of the current monitor.
fn restore_spotlight_position(win: &tauri::WebviewWindow, state: &SpotlightState) {
    let last_pos = state.spotlight_position.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((x, y)) = *last_pos {
        let _ = win.set_position(LogicalPosition::new(x, y));
    } else {
        let (x, y) = default_spotlight_position(win);
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
}

/// Configure the window as Spotlight mode.
/// Keeps decorations on but hides traffic light buttons via cocoa API.
fn configure_as_spotlight(win: &tauri::WebviewWindow, state: &SpotlightState) {
    #[cfg(target_os = "macos")]
    hide_traffic_lights(win);

    let _ = win.set_min_size(Some(LogicalSize::new(320.0, 300.0)));
    let _ = win.set_size(LogicalSize::new(SPOTLIGHT_WIDTH, SPOTLIGHT_HEIGHT));
    let _ = win.set_skip_taskbar(true);
    let pinned = *state.pinned.lock().unwrap_or_else(|e| e.into_inner());
    let _ = win.set_always_on_top(pinned);
    restore_spotlight_position(win, state);
}

/// Configure the window as Main mode (overlay title bar style; native traffic lights).
fn configure_as_main(win: &tauri::WebviewWindow, state: &SpotlightState) {
    let _ = win.set_always_on_top(false);
    let _ = win.set_skip_taskbar(false);
    let _ = win.set_min_size(Some(LogicalSize::new(800.0, 600.0)));

    // Restore saved main geometry or center at default size
    let geom = state.main_geometry.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((x, y, w, h)) = *geom {
        let _ = win.set_size(LogicalSize::new(w, h));
        let _ = win.set_position(LogicalPosition::new(x, y));
    } else {
        let _ = win.set_size(LogicalSize::new(MAIN_WIDTH, MAIN_HEIGHT));
        let _ = win.center();
    }

    #[cfg(target_os = "macos")]
    show_traffic_lights(win);
}

/// Save the current window geometry as main geometry.
pub fn save_main_geometry(win: &tauri::WebviewWindow, state: &SpotlightState) {
    let scale = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    if let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) {
        let mut geom = state.main_geometry.lock().unwrap_or_else(|e| e.into_inner());
        *geom = Some((
            pos.x as f64 / scale,
            pos.y as f64 / scale,
            size.width as f64 / scale,
            size.height as f64 / scale,
        ));
    }
}

/// Show window and ensure macOS brings it to the front.
/// Tauri's `show()` + `set_focus()` alone may not activate the app from background.
fn show_and_activate(win: &tauri::WebviewWindow) {
    let _ = win.show();
    let _ = win.set_focus();

    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSApp;
        use cocoa::base::{id, nil};
        use objc::{msg_send, sel, sel_impl};
        unsafe {
            let ns_app = NSApp();
            let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
        }
        // Also ensure window is ordered front
        if let Ok(ns_win) = win.ns_window() {
            let ns_win = ns_win as id;
            let _: () = unsafe { msg_send![ns_win, makeKeyAndOrderFront: nil] };
        }
    }
}

/// Emit spotlight-opened event with clipboard text (if any).
fn emit_spotlight_opened(app: &AppHandle) {
    let _ = app.emit("spotlight-mode-changed", true);
    // Read clipboard and send to frontend for auto-paste into input
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        if let Ok(text) = clipboard.get_text() {
            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() {
                let _ = app.emit("spotlight-clipboard", trimmed);
            }
        }
    }
}

// --- Commands ---

/// Toggle spotlight window visibility (called by global shortcut).
/// If visible + Main mode -> switch to spotlight.
/// If visible + Spotlight mode -> hide.
/// If hidden -> show as Spotlight.
#[tauri::command]
pub fn toggle_spotlight(app: AppHandle, state: State<'_, SpotlightState>) {
    let win = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };

    let visible = win.is_visible().unwrap_or(false);
    let mode = *state.mode.lock().unwrap_or_else(|e| e.into_inner());

    if visible {
        match mode {
            WindowMode::Main => {
                // Switch from main mode to spotlight mode
                save_main_geometry(&win, &state);
                *state.mode.lock().unwrap_or_else(|e| e.into_inner()) = WindowMode::Spotlight;
                configure_as_spotlight(&win, &state);
                emit_spotlight_opened(&app);
                show_and_activate(&win);
            }
            WindowMode::Spotlight => {
                save_spotlight_position(&win, &state);
                let _ = win.hide();
            }
        }
    } else {
        // Show as spotlight (was hidden) — set alpha=0 first to prevent flash
        *state.mode.lock().unwrap_or_else(|e| e.into_inner()) = WindowMode::Spotlight;
        configure_as_spotlight(&win, &state);
        emit_spotlight_opened(&app);
        #[cfg(target_os = "macos")]
        set_window_alpha(&win, 0.0);
        show_and_activate(&win);
        // Fade in after one frame so WebView can render before becoming visible
        #[cfg(target_os = "macos")]
        {
            let win_clone = win.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(20));
                set_window_alpha(&win_clone, 1.0);
            });
        }
    }
}

/// Toggle spotlight from tray click — always shows spotlight.
/// If in main mode and visible, hides first then shows as spotlight.
pub fn toggle_spotlight_from_tray(app: AppHandle, state: State<'_, SpotlightState>) {
    let win = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };

    let visible = win.is_visible().unwrap_or(false);
    let mode = *state.mode.lock().unwrap_or_else(|e| e.into_inner());

    if visible && mode == WindowMode::Spotlight {
        // Toggle off
        save_spotlight_position(&win, &state);
        let _ = win.hide();
    } else {
        // If in main mode and visible, save main geometry first
        if visible && mode == WindowMode::Main {
            save_main_geometry(&win, &state);
            let _ = win.hide();
        }

        // Switch to spotlight mode — set alpha=0 first to prevent flash
        *state.mode.lock().unwrap_or_else(|e| e.into_inner()) = WindowMode::Spotlight;
        configure_as_spotlight(&win, &state);
        emit_spotlight_opened(&app);
        #[cfg(target_os = "macos")]
        set_window_alpha(&win, 0.0);
        show_and_activate(&win);
        #[cfg(target_os = "macos")]
        {
            let win_clone = win.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(20));
                set_window_alpha(&win_clone, 1.0);
            });
        }
    }
}

/// Set spotlight window always-on-top state and persist it.
#[tauri::command]
pub fn set_spotlight_pin(app: AppHandle, state: State<'_, SpotlightState>, pinned: bool) {
    *state.pinned.lock().unwrap_or_else(|e| e.into_inner()) = pinned;

    let mode = *state.mode.lock().unwrap_or_else(|e| e.into_inner());
    if mode == WindowMode::Spotlight {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_always_on_top(pinned);
        }
    }
}

/// Animated transition from Spotlight to Main mode.
/// Uses 15 steps over ~300ms with ease-out cubic easing.
///
/// This is a synchronous command so it runs on the main thread, which is
/// required for macOS AppKit/Cocoa window operations (set_size, set_position,
/// traffic light manipulation). Using `async` would run on a tokio worker thread
/// and cause SIGABRT when touching AppKit APIs.
#[tauri::command]
pub fn expand_to_main(app: AppHandle, state: State<'_, SpotlightState>) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("Window not found")?;

    let current_mode = *state.mode.lock().map_err(|e| e.to_string())?;
    if current_mode != WindowMode::Spotlight {
        return Ok(());
    }

    // Get current spotlight geometry
    let scale = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    let start_pos = win.outer_position().map_err(|e| e.to_string())?;
    let start_size = win.outer_size().map_err(|e| e.to_string())?;

    let start_x = start_pos.x as f64 / scale;
    let start_y = start_pos.y as f64 / scale;
    let start_w = start_size.width as f64 / scale;
    let start_h = start_size.height as f64 / scale;

    // Determine target geometry
    let (target_x, target_y, target_w, target_h) = {
        let geom = state.main_geometry.lock().map_err(|e| e.to_string())?;
        if let Some((x, y, w, h)) = *geom {
            (x, y, w, h)
        } else {
            // Center on screen
            if let Some(monitor) = win.current_monitor().ok().flatten() {
                let screen = monitor.size();
                let sx = (screen.width as f64 / scale - MAIN_WIDTH) / 2.0;
                let sy = (screen.height as f64 / scale - MAIN_HEIGHT) / 2.0;
                (sx, sy, MAIN_WIDTH, MAIN_HEIGHT)
            } else {
                (100.0, 100.0, MAIN_WIDTH, MAIN_HEIGHT)
            }
        }
    };

    // Save spotlight position before transition
    save_spotlight_position(&win, &state);

    // Update mode BEFORE animation
    *state.mode.lock().map_err(|e| e.to_string())? = WindowMode::Main;

    // Remove always-on-top and skip-taskbar during animation
    let _ = win.set_always_on_top(false);
    let _ = win.set_skip_taskbar(false);
    // Remove min-size constraint so we can animate freely
    let _ = win.set_min_size::<LogicalSize<f64>>(None);

    // Animate: 15 steps over ~300ms
    let steps = 15;
    let step_duration = std::time::Duration::from_millis(20); // 15 * 20ms = 300ms

    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        // Ease-out cubic: 1 - (1 - t)^3
        let eased = 1.0 - (1.0 - t).powi(3);

        let x = start_x + (target_x - start_x) * eased;
        let y = start_y + (target_y - start_y) * eased;
        let w = start_w + (target_w - start_w) * eased;
        let h = start_h + (target_h - start_h) * eased;

        let _ = win.set_size(LogicalSize::new(w, h));
        let _ = win.set_position(LogicalPosition::new(x, y));

        std::thread::sleep(step_duration);
    }

    // Apply final main mode settings AFTER animation.
    let _ = win.set_min_size(Some(LogicalSize::new(800.0, 600.0)));

    // Show and position traffic lights
    #[cfg(target_os = "macos")]
    show_traffic_lights(&win);

    let _ = win.set_focus();

    // Emit mode change AFTER animation so frontend switches to main layout
    // only when the window is already at full size (avoids layout thrashing)
    let _ = app.emit("spotlight-mode-changed", false);

    Ok(())
}

/// Directly show as Main mode (from tray menu).
#[tauri::command]
pub fn show_main_window(app: AppHandle, state: State<'_, SpotlightState>) {
    let win = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };

    let current_mode = *state.mode.lock().unwrap_or_else(|e| e.into_inner());

    // If currently visible in spotlight mode, save position
    if win.is_visible().unwrap_or(false) && current_mode == WindowMode::Spotlight {
        save_spotlight_position(&win, &state);
    }

    *state.mode.lock().unwrap_or_else(|e| e.into_inner()) = WindowMode::Main;
    configure_as_main(&win, &state);
    let _ = app.emit("spotlight-mode-changed", false);
    show_and_activate(&win);
}

/// Force-toggle spotlight (bypasses main-window guard). Used by tray and tests.
#[tauri::command]
pub fn force_toggle_spotlight(app: AppHandle, state: State<'_, SpotlightState>) {
    toggle_spotlight_from_tray(app, state);
}

/// Get spotlight window state for testing/debugging.
#[tauri::command]
pub fn get_spotlight_state(app: AppHandle, state: State<'_, SpotlightState>) -> serde_json::Value {
    let pinned = *state.pinned.lock().unwrap_or_else(|e| e.into_inner());
    let mode = *state.mode.lock().unwrap_or_else(|e| e.into_inner());
    let visible = app
        .get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    serde_json::json!({
        "pinned": pinned,
        "visible": visible,
        "mode": if mode == WindowMode::Spotlight { "spotlight" } else { "main" },
    })
}
