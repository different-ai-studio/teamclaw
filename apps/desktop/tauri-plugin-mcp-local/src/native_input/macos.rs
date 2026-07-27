use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{mpsc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use tauri::{Runtime, Webview};
use log::{debug, warn};

use crate::error::Error;
use super::{InputResult, MouseButton, MouseParams, TextParams, TextResult};

// ---- Raw ObjC runtime FFI (replaces objc 0.2 / cocoa crates) ----

type Id = *mut c_void;
type Class = *mut c_void;
type Sel = *mut c_void;
const NIL: Id = std::ptr::null_mut();

#[repr(C)]
#[derive(Clone, Copy)]
struct NSPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct NSSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct NSRect {
    origin: NSPoint,
    size: NSSize,
}

#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
    fn objc_getClass(name: *const u8) -> Class;
    fn sel_registerName(name: *const u8) -> Sel;
    fn objc_msgSend();
}

// On x86_64, struct returns > 16 bytes use a different entry point.
#[cfg(target_arch = "x86_64")]
#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
    fn objc_msgSend_stret();
}

// ---- Typed message-send trampolines ----
// Each transmutes objc_msgSend to the exact C calling convention needed.

// () return, 1 Id arg: [app sendEvent:event]
type MsgSendVoidId = unsafe extern "C" fn(Id, Sel, Id);
// () return, 1 BOOL arg: [app activateIgnoringOtherApps:YES]
type MsgSendVoidBool = unsafe extern "C" fn(Id, Sel, i8);
// Id return, no extra args: [cls alloc], [obj autorelease], [NSApp sharedApplication]
type MsgSendId = unsafe extern "C" fn(Id, Sel) -> Id;
// i64 return, no extra args: [window windowNumber]
type MsgSendI64 = unsafe extern "C" fn(Id, Sel) -> i64;
// Id return, 3 args: [NSString initWithBytes:length:encoding:]
type MsgSendInitStr = unsafe extern "C" fn(Id, Sel, *const c_void, usize, u64) -> Id;

// NSRect return — platform-specific entry point
// arm64: regular objc_msgSend returns structs in registers
// x86_64: structs > 16 bytes go through objc_msgSend_stret(out_ptr, self, _cmd, ...)
#[cfg(target_arch = "aarch64")]
type MsgSendRect = unsafe extern "C" fn(Id, Sel) -> NSRect;
#[cfg(target_arch = "aarch64")]
type MsgSendRectRect = unsafe extern "C" fn(Id, Sel, NSRect) -> NSRect;

#[cfg(target_arch = "x86_64")]
type MsgSendStretRect = unsafe extern "C" fn(*mut NSRect, Id, Sel);
#[cfg(target_arch = "x86_64")]
type MsgSendStretRectRect = unsafe extern "C" fn(*mut NSRect, Id, Sel, NSRect);

// keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:
type MsgSendKeyEvent = unsafe extern "C" fn(
    Class, Sel,
    u64, NSPoint, u64, f64, i64, Id, Id, Id, i8, u16,
) -> Id;

// ---- Helpers ----

unsafe fn class(name: &[u8]) -> Class {
    unsafe { objc_getClass(name.as_ptr()) }
}

unsafe fn sel(name: &[u8]) -> Sel {
    unsafe { sel_registerName(name.as_ptr()) }
}

/// Get an NSRect by sending a no-arg message (e.g. [window frame])
#[cfg(target_arch = "aarch64")]
unsafe fn msg_send_rect(obj: Id, sel: Sel) -> NSRect {
    unsafe {
        let f: MsgSendRect = std::mem::transmute(objc_msgSend as *const c_void);
        f(obj, sel)
    }
}

#[cfg(target_arch = "x86_64")]
unsafe fn msg_send_rect(obj: Id, sel: Sel) -> NSRect {
    unsafe {
        let mut result = std::mem::zeroed::<NSRect>();
        let f: MsgSendStretRect = std::mem::transmute(objc_msgSend_stret as *const c_void);
        f(&mut result, obj, sel);
        result
    }
}

/// Get an NSRect by sending a message with one NSRect arg (e.g. [window contentRectForFrameRect:])
#[cfg(target_arch = "aarch64")]
unsafe fn msg_send_rect_rect(obj: Id, sel: Sel, arg: NSRect) -> NSRect {
    unsafe {
        let f: MsgSendRectRect = std::mem::transmute(objc_msgSend as *const c_void);
        f(obj, sel, arg)
    }
}

#[cfg(target_arch = "x86_64")]
unsafe fn msg_send_rect_rect(obj: Id, sel: Sel, arg: NSRect) -> NSRect {
    unsafe {
        let mut result = std::mem::zeroed::<NSRect>();
        let f: MsgSendStretRectRect = std::mem::transmute(objc_msgSend_stret as *const c_void);
        f(&mut result, obj, sel, arg);
        result
    }
}

// ---- NSEventType constants (keyboard path only) ----

const NS_KEY_DOWN: u64 = 10;
const NS_KEY_UP: u64 = 11;

/// Get the window number for an NSWindow.
unsafe fn get_window_number(ns_window: Id) -> i64 {
    unsafe {
        let f: MsgSendI64 = std::mem::transmute(objc_msgSend as *const c_void);
        f(ns_window, sel(b"windowNumber\0"))
    }
}

// ---- CoreGraphics FFI (window-server mouse injection) ----
//
// Mouse events are deliberately NOT delivered via [NSApp sendEvent:].
// Synthetic sendEvent: calls bypass the real event queue; when the
// coordinates land near a window resize edge, AppKit's mouse-hysteresis
// check spins a NESTED run loop waiting for a follow-up event from the
// real queue — which sendEvent: never feeds — deadlocking the main
// thread (observed: ~18 min main-thread freeze, all samples in mach_msg).
// Posting through CGEventPost(kCGHIDEventTap) hands the event to the
// window server, so AppKit receives it through the genuine event queue
// and nested run loops can complete.
//
// Note: posting to the HID event tap moves the real cursor and requires
// the process to be trusted for Accessibility on hardened systems.

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

type CGEventRef = *mut c_void;

const K_CG_HID_EVENT_TAP: u32 = 0;

// CGEventType
const CG_EVENT_LEFT_MOUSE_DOWN: u32 = 1;
const CG_EVENT_LEFT_MOUSE_UP: u32 = 2;
const CG_EVENT_RIGHT_MOUSE_DOWN: u32 = 3;
const CG_EVENT_RIGHT_MOUSE_UP: u32 = 4;
const CG_EVENT_MOUSE_MOVED: u32 = 5;
const CG_EVENT_LEFT_MOUSE_DRAGGED: u32 = 6;
const CG_EVENT_RIGHT_MOUSE_DRAGGED: u32 = 7;
const CG_EVENT_OTHER_MOUSE_DOWN: u32 = 25;
const CG_EVENT_OTHER_MOUSE_UP: u32 = 26;
const CG_EVENT_OTHER_MOUSE_DRAGGED: u32 = 27;

// CGMouseButton
const CG_MOUSE_BUTTON_LEFT: u32 = 0;
const CG_MOUSE_BUTTON_RIGHT: u32 = 1;
const CG_MOUSE_BUTTON_CENTER: u32 = 2;

// CGEventField
const K_CG_MOUSE_EVENT_CLICK_STATE: u32 = 1;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateMouseEvent(
        source: *const c_void,
        event_type: u32,
        position: CGPoint,
        button: u32,
    ) -> CGEventRef;
    fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

/// A mouse button held open by a `mouse_down`-only call, plus the last
/// position it was posted at so it can be released at the same point.
#[derive(Clone, Copy)]
struct PressedButton {
    /// CG mouse button number (CG_MOUSE_BUTTON_*).
    button: i32,
    /// Global position of the most recent down/drag event for this button.
    position: CGPoint,
}

/// Which CG mouse button is currently held by a `mouse_down`-only call,
/// keyed by NSWindow window number (absent = none held for that window).
/// Keying per window keeps interleaved drag operations across different
/// windows from corrupting each other's state. Used so intermediate moves
/// during a drag are posted as *Dragged events (real HID semantics) and so
/// a `click`/`mouse_up` always clears the pressed state — a synthetic
/// mouseDown is never left unpaired by the `click` path within a single
/// dispatch. `release_held_buttons()` drains this on connection close so an
/// interrupted drag can't leave the real cursor's button physically pressed.
static PRESSED_CG_BUTTONS: LazyLock<Mutex<HashMap<i64, PressedButton>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn pressed_cg_buttons() -> MutexGuard<'static, HashMap<i64, PressedButton>> {
    PRESSED_CG_BUTTONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Force-release any mouse buttons still held open by `mouse_down`-only calls.
///
/// A drag is expressed as `mouse_down` -> `move`* -> `mouse_up` across separate
/// requests. Because `CGEventPost` drives the real window-server input state, a
/// `mouse_down` whose paired `mouse_up` never arrives — the client crashed,
/// disconnected, or panicked mid-drag — leaves the physical mouse button
/// pressed, wedging the user's actual cursor. Call this when a client
/// connection ends to post the matching button-up for anything still held.
pub fn release_held_buttons() {
    let mut held = pressed_cg_buttons();
    for (window_number, pressed) in held.drain() {
        let up_type = match pressed.button as u32 {
            CG_MOUSE_BUTTON_RIGHT => CG_EVENT_RIGHT_MOUSE_UP,
            CG_MOUSE_BUTTON_CENTER => CG_EVENT_OTHER_MOUSE_UP,
            _ => CG_EVENT_LEFT_MOUSE_UP,
        };
        warn!(
            "[NATIVE_INPUT] Releasing unpaired mouse button {} held for window {} (interrupted drag)",
            pressed.button, window_number
        );
        post_mouse_event(up_type, pressed.position, pressed.button as u32, 1);
    }
}

/// Keep injected coordinates this many points away from the window's
/// content-rect edges so they can't land in AppKit's window-edge resize
/// bands (the trigger for the hysteresis nested run loop).
const RESIZE_EDGE_INSET: f64 = 8.0;

fn clamp_inset(v: f64, max: f64, inset: f64) -> f64 {
    if max <= inset * 2.0 {
        return max / 2.0;
    }
    v.max(inset).min(max - inset)
}

/// Create + post one mouse event through the HID event tap, then release it.
fn post_mouse_event(event_type: u32, position: CGPoint, button: u32, click_state: i64) {
    unsafe {
        let event = CGEventCreateMouseEvent(std::ptr::null(), event_type, position, button);
        if event.is_null() {
            debug!("[NATIVE_INPUT] CGEventCreateMouseEvent returned null (type={})", event_type);
            return;
        }
        if click_state > 0 {
            CGEventSetIntegerValueField(event, K_CG_MOUSE_EVENT_CLICK_STATE, click_state);
        }
        CGEventPost(K_CG_HID_EVENT_TAP, event);
        CFRelease(event);
    }
}

/// Create and send an NSEvent keyboard event to [NSApp sendEvent:].
unsafe fn send_key_event(
    event_type: u64,
    characters: Id, // NSString
    window_number: i64,
) {
    unsafe {
        let send_id: MsgSendId = std::mem::transmute(objc_msgSend as *const c_void);
        let ns_app = send_id(
            class(b"NSApplication\0"),
            sel(b"sharedApplication\0"),
        );

        let create: MsgSendKeyEvent = std::mem::transmute(objc_msgSend as *const c_void);
        let event = create(
            class(b"NSEvent\0"),
            sel(b"keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:\0"),
            event_type,
            NSPoint { x: 0.0, y: 0.0 },
            0u64, 0.0f64, window_number, NIL,
            characters, characters,
            0i8, // isARepeat = NO
            0u16, // keyCode
        );

        let send_event: MsgSendVoidId = std::mem::transmute(objc_msgSend as *const c_void);
        send_event(ns_app, sel(b"sendEvent:\0"), event);
    }
}

/// Convert a Rust &str to an autoreleased NSString.
unsafe fn nsstring_from_str(s: &str) -> Id {
    unsafe {
        let send_id: MsgSendId = std::mem::transmute(objc_msgSend as *const c_void);
        let raw = send_id(class(b"NSString\0"), sel(b"alloc\0"));

        let init: MsgSendInitStr = std::mem::transmute(objc_msgSend as *const c_void);
        let ns_str = init(
            raw,
            sel(b"initWithBytes:length:encoding:\0"),
            s.as_ptr() as *const c_void,
            s.len(),
            4u64, // NSUTF8StringEncoding
        );

        send_id(ns_str, sel(b"autorelease\0"))
    }
}

// ---- Public API ----

/// Inject mouse events for the webview's NSWindow.
///
/// Two phases:
/// 1. Main thread (inside with_webview): read window geometry only —
///    no event dispatch — and convert the caller's window-relative CSS
///    coordinates (top-left origin, logical points) into GLOBAL CG
///    screen coordinates. Never runs a nested run loop, so it cannot
///    deadlock.
/// 2. Calling thread (a worker, NOT the main thread): post the events
///    via CGEventPost(kCGHIDEventTap) so AppKit receives them through
///    the real event queue while the main thread is free to pump it.
///
/// Coordinate conversion:
///   CSS (x, y)                             top-left of content, y down
///   -> AppKit screen point:  content.origin + (x, height - y)   y up,
///      origin at bottom-left of the main display (contentRectForFrameRect:
///      of [window frame] is already in AppKit global screen coords, so
///      this is correct on any display of a multi-monitor setup)
///   -> CG global point:      (x, mainDisplayHeight - y_appkit)  y down,
///      origin at top-left of the main display — what CGEventPost expects.
pub fn inject_mouse<R: Runtime>(
    webview: &Webview<R>,
    params: &MouseParams,
) -> Result<InputResult, Error> {
    let x = params.x;
    let y = params.y;
    let click = params.click;
    let button = params.button;
    let mouse_down = params.mouse_down;
    let mouse_up = params.mouse_up;
    let wants_button_event = click || mouse_down || mouse_up;

    // Native mouse events go through CGEventPost(kCGHIDEventTap), which the
    // window server silently drops unless the host process is trusted for
    // Accessibility. Without this check the tool reports success while the
    // click lands nowhere. Fail loudly with guidance instead — selector-based
    // clicks (click with selector_type/selector_value) use synthetic DOM
    // events and need no permission, so steer callers there.
    if unsafe { !AXIsProcessTrusted() } {
        return Err(Error::Anyhow(
            "macOS Accessibility permission is required for native mouse events \
             (hover, drag, and raw x/y clicks). Grant it in System Settings → \
             Privacy & Security → Accessibility for the process running this app \
             (your terminal in dev, or the app bundle), then restart it. \
             Tip: selector-based clicks (pass selector_type/selector_value to the \
             click tool) dispatch synthetic DOM events and do NOT need this permission."
                .to_string(),
        ));
    }

    let (tx, rx) = mpsc::channel();

    webview
        .with_webview(move |platform_wv| {
            let result: Result<(f64, f64, CGPoint, i64), String> = unsafe {
                let ns_window: Id = platform_wv.ns_window();
                if ns_window.is_null() {
                    Err("NSWindow is nil".to_string())
                } else {
                    let frame = msg_send_rect(ns_window, sel(b"frame\0"));
                    let content = msg_send_rect_rect(
                        ns_window,
                        sel(b"contentRectForFrameRect:\0"),
                        frame,
                    );

                    // Clamp away from the window-edge resize bands so a
                    // click can never engage AppKit's resize hysteresis.
                    let css_x = clamp_inset(x as f64, content.size.width, RESIZE_EDGE_INSET);
                    let css_y = clamp_inset(y as f64, content.size.height, RESIZE_EDGE_INSET);

                    // CSS (top-left, window-relative) -> AppKit global screen (bottom-left, y up)
                    let appkit_x = content.origin.x + css_x;
                    let appkit_y = content.origin.y + (content.size.height - css_y);

                    // AppKit global -> CG global (top-left of main display, y down)
                    let main_height = CGDisplayBounds(CGMainDisplayID()).size.height;
                    let global = CGPoint {
                        x: appkit_x,
                        y: main_height - appkit_y,
                    };

                    if wants_button_event {
                        // HID-tap events route to whatever window is under the
                        // cursor; bring ours to front so the click lands on it
                        // (matches the old sendEvent: "always our window" behavior).
                        let send_void_id: MsgSendVoidId =
                            std::mem::transmute(objc_msgSend as *const c_void);
                        send_void_id(ns_window, sel(b"makeKeyAndOrderFront:\0"), NIL);

                        let send_id: MsgSendId =
                            std::mem::transmute(objc_msgSend as *const c_void);
                        let ns_app =
                            send_id(class(b"NSApplication\0"), sel(b"sharedApplication\0"));
                        let send_void_bool: MsgSendVoidBool =
                            std::mem::transmute(objc_msgSend as *const c_void);
                        send_void_bool(ns_app, sel(b"activateIgnoringOtherApps:\0"), 1);
                    }

                    debug!(
                        "[NATIVE_INPUT] macOS mouse: css=({}, {}) clamped=({}, {}), appkit_global=({}, {}), cg_global=({}, {})",
                        x, y, css_x, css_y, appkit_x, appkit_y, global.x, global.y
                    );

                    Ok((css_x, css_y, global, get_window_number(ns_window)))
                }
            };

            tx.send(result).unwrap_or(());
        })
        .map_err(|e| Error::Anyhow(format!("with_webview failed: {}", e)))?;

    let (css_x, css_y, global, window_number) = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| Error::Anyhow(format!("with_webview timed out: {}", e)))?
        .map_err(Error::Anyhow)?;

    let cg_button = match button {
        MouseButton::Left => CG_MOUSE_BUTTON_LEFT,
        MouseButton::Right => CG_MOUSE_BUTTON_RIGHT,
        MouseButton::Middle => CG_MOUSE_BUTTON_CENTER,
    };
    let (down_type, up_type) = match button {
        MouseButton::Left => (CG_EVENT_LEFT_MOUSE_DOWN, CG_EVENT_LEFT_MOUSE_UP),
        MouseButton::Right => (CG_EVENT_RIGHT_MOUSE_DOWN, CG_EVENT_RIGHT_MOUSE_UP),
        MouseButton::Middle => (CG_EVENT_OTHER_MOUSE_DOWN, CG_EVENT_OTHER_MOUSE_UP),
    };

    // Move to the target first. If a button is held for THIS window from a
    // previous mouse_down-only call, this is mid-drag: post a *Dragged event
    // with the held button so drag semantics are preserved.
    let held = pressed_cg_buttons()
        .get(&window_number)
        .map(|p| p.button)
        .unwrap_or(-1);
    if held >= 0 {
        let (drag_type, drag_button) = match held as u32 {
            CG_MOUSE_BUTTON_RIGHT => (CG_EVENT_RIGHT_MOUSE_DRAGGED, CG_MOUSE_BUTTON_RIGHT),
            CG_MOUSE_BUTTON_CENTER => (CG_EVENT_OTHER_MOUSE_DRAGGED, CG_MOUSE_BUTTON_CENTER),
            _ => (CG_EVENT_LEFT_MOUSE_DRAGGED, CG_MOUSE_BUTTON_LEFT),
        };
        post_mouse_event(drag_type, global, drag_button, 0);
        // Refresh the held position so a force-release lands at the last
        // known drag point rather than the original mouse_down location.
        if let Some(pressed) = pressed_cg_buttons().get_mut(&window_number) {
            pressed.position = global;
        }
    } else {
        post_mouse_event(CG_EVENT_MOUSE_MOVED, global, cg_button, 0);
    }

    if click {
        // Down and up are always paired within this single dispatch.
        post_mouse_event(down_type, global, cg_button, 1);
        std::thread::sleep(Duration::from_millis(20));
        post_mouse_event(up_type, global, cg_button, 1);
        pressed_cg_buttons().remove(&window_number);
    } else if mouse_down {
        // Down-only mode exists to support drags (down -> move -> up
        // across separate calls). With window-server delivery this can
        // no longer wedge a nested run loop, but callers MUST follow up
        // with mouse_up; PRESSED_CG_BUTTONS tracks the debt per window.
        post_mouse_event(down_type, global, cg_button, 1);
        pressed_cg_buttons().insert(
            window_number,
            PressedButton { button: cg_button as i32, position: global },
        );
    } else if mouse_up {
        post_mouse_event(up_type, global, cg_button, 1);
        pressed_cg_buttons().remove(&window_number);
    }

    Ok(InputResult {
        success: true,
        position: (css_x.round() as i32, css_y.round() as i32),
        error: None,
    })
}

/// Inject text as keyboard events into the webview's NSWindow via with_webview.
/// For delay_ms > 0, injects characters one at a time.
pub fn inject_text<R: Runtime>(
    webview: &Webview<R>,
    params: &TextParams,
) -> Result<TextResult, Error> {
    let text = params.text.clone();
    let chars: Vec<char> = text.chars().collect();
    let total_chars = chars.len() as u32;

    if params.delay_ms == 0 {
        // Fast path: inject entire string at once
        let (tx, rx) = mpsc::channel();

        webview
            .with_webview(move |platform_wv| {
                let result: Result<(), String> = unsafe {
                    let ns_window: Id = platform_wv.ns_window();
                    if ns_window.is_null() {
                        return tx.send(Err("NSWindow is nil".to_string())).unwrap_or(());
                    }

                    let window_number = get_window_number(ns_window);
                    let ns_str = nsstring_from_str(&text);

                    send_key_event(NS_KEY_DOWN, ns_str, window_number);
                    send_key_event(NS_KEY_UP, ns_str, window_number);

                    Ok(())
                };

                tx.send(result).unwrap_or(());
            })
            .map_err(|e| Error::Anyhow(format!("with_webview failed: {}", e)))?;

        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| Error::Anyhow(format!("with_webview timed out: {}", e)))?
            .map_err(Error::Anyhow)?;
    } else {
        // Slow path: character by character with delays
        for ch in &chars {
            let ch_string = ch.to_string();
            let (tx, rx) = mpsc::channel();

            webview
                .with_webview(move |platform_wv| {
                    let result: Result<(), String> = unsafe {
                        let ns_window: Id = platform_wv.ns_window();
                        if ns_window.is_null() {
                            return tx.send(Err("NSWindow is nil".to_string())).unwrap_or(());
                        }

                        let window_number = get_window_number(ns_window);
                        let ns_str = nsstring_from_str(&ch_string);

                        send_key_event(NS_KEY_DOWN, ns_str, window_number);
                        send_key_event(NS_KEY_UP, ns_str, window_number);

                        Ok(())
                    };

                    tx.send(result).unwrap_or(());
                })
                .map_err(|e| Error::Anyhow(format!("with_webview failed: {}", e)))?;

            rx.recv_timeout(Duration::from_secs(5))
                .map_err(|e| Error::Anyhow(format!("with_webview timed out: {}", e)))?
                .map_err(Error::Anyhow)?;

            std::thread::sleep(Duration::from_millis(params.delay_ms));
        }
    }

    Ok(TextResult {
        success: true,
        chars_typed: total_chars,
        error: None,
    })
}
