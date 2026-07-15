use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager};

const MAIN_WIDTH: f64 = 1200.0;
const MAIN_HEIGHT: f64 = 800.0;

pub struct MainWindowState {
    pub main_geometry: Mutex<Option<(f64, f64, f64, f64)>>,
    /// Set when the user hides the window (red close button). Restored on dock Reopen.
    pub was_fullscreen: Mutex<bool>,
}

impl Default for MainWindowState {
    fn default() -> Self {
        Self {
            main_geometry: Mutex::new(None),
            was_fullscreen: Mutex::new(false),
        }
    }
}

#[cfg(target_os = "macos")]
pub fn reposition_traffic_lights(win: &tauri::WebviewWindow) {
    use cocoa::appkit::{NSWindow, NSWindowButton};
    use cocoa::base::id;
    use cocoa::foundation::NSPoint;
    use objc::{msg_send, sel, sel_impl};

    const OFFSET_X: f64 = 10.0;
    const OFFSET_Y: f64 = 10.0;

    static ORIGINAL_ORIGINS: OnceLock<[(f64, f64); 3]> = OnceLock::new();

    if let Ok(ns_window) = win.ns_window() {
        let ns_window = ns_window as id;
        unsafe {
            let buttons = [
                ns_window.standardWindowButton_(NSWindowButton::NSWindowCloseButton),
                ns_window.standardWindowButton_(NSWindowButton::NSWindowMiniaturizeButton),
                ns_window.standardWindowButton_(NSWindowButton::NSWindowZoomButton),
            ];

            let origins = ORIGINAL_ORIGINS.get_or_init(|| {
                let mut result = [(0.0, 0.0); 3];
                for (i, btn) in buttons.iter().enumerate() {
                    let frame: cocoa::foundation::NSRect = msg_send![*btn, frame];
                    result[i] = (frame.origin.x, frame.origin.y);
                }
                result
            });

            for (i, btn) in buttons.iter().enumerate() {
                let (orig_x, orig_y) = origins[i];
                let new_origin = NSPoint::new(orig_x + OFFSET_X, orig_y - OFFSET_Y);
                let _: () = msg_send![*btn, setFrameOrigin: new_origin];
            }
        }
    }
}

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

fn rect_visible_on_any_monitor(win: &tauri::WebviewWindow, x: f64, y: f64, w: f64, h: f64) -> bool {
    let Ok(monitors) = win.available_monitors() else {
        return false;
    };
    for monitor in monitors {
        let scale = monitor.scale_factor();
        let pos = monitor.position();
        let size = monitor.size();
        let mx = pos.x as f64 / scale;
        let my = pos.y as f64 / scale;
        let mw = size.width as f64 / scale;
        let mh = size.height as f64 / scale;
        let visible_w = (x + w).min(mx + mw) - x.max(mx);
        let visible_h = (y + h).min(my + mh) - y.max(my);
        if visible_w > 50.0 && visible_h > 50.0 {
            return true;
        }
    }
    false
}

pub fn save_main_geometry(win: &tauri::WebviewWindow, state: &MainWindowState) {
    let scale = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    if let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) {
        let mut geom = state
            .main_geometry
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *geom = Some((
            pos.x as f64 / scale,
            pos.y as f64 / scale,
            size.width as f64 / scale,
            size.height as f64 / scale,
        ));
    }
}

/// Persist window mode before hide. Fullscreen geometry is not saved — macOS
/// reports screen-sized frames that restore incorrectly as a small window.
pub fn save_main_window_state(win: &tauri::WebviewWindow, state: &MainWindowState) {
    let is_fullscreen = win.is_fullscreen().unwrap_or(false);
    *state
        .was_fullscreen
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = is_fullscreen;
    if !is_fullscreen {
        save_main_geometry(win, state);
    }
}

fn restore_main_geometry(win: &tauri::WebviewWindow, state: &MainWindowState) {
    let geom = *state
        .main_geometry
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let restored = match geom {
        Some((x, y, w, h)) if rect_visible_on_any_monitor(win, x, y, w, h) => {
            let _ = win.set_size(LogicalSize::new(w, h));
            let _ = win.set_position(LogicalPosition::new(x, y));
            true
        }
        _ => false,
    };
    if !restored {
        let _ = win.set_size(LogicalSize::new(MAIN_WIDTH, MAIN_HEIGHT));
        let _ = win.center();
    }
}

fn show_and_activate(win: &tauri::WebviewWindow) {
    let _ = win.unminimize();
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
        if let Ok(ns_win) = win.ns_window() {
            let ns_win = ns_win as id;
            let _: () = unsafe { msg_send![ns_win, makeKeyAndOrderFront: nil] };
        }
    }
}

#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle, state: tauri::State<'_, MainWindowState>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    let already_visible = win.is_visible().unwrap_or(false);

    let _ = win.set_always_on_top(false);
    let _ = win.set_skip_taskbar(false);
    let _ = win.set_min_size(Some(LogicalSize::new(800.0, 600.0)));

    // Dock Reopen while the window is already on screen (e.g. native fullscreen)
    // must only focus — restoring saved geometry would shrink/move the window.
    if !already_visible {
        let was_fullscreen = *state
            .was_fullscreen
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if was_fullscreen {
            let _ = win.set_fullscreen(true);
        } else {
            restore_main_geometry(&win, &state);
        }

        #[cfg(target_os = "macos")]
        show_traffic_lights(&win);
    }

    let _ = app.emit("main-window-shown", ());
    show_and_activate(&win);
}
