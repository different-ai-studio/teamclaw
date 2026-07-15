//! System appearance bridges — mirror native preferences into the WebView.
//!
//! Skill tenet T3 (*adopt the platform; don't compete with it*): the user
//! already picked an accent color in System Settings. We mirror it onto a
//! CSS variable so focus rings and selection states track what the rest of
//! the OS does, instead of hardcoding a brand color.
//!
//! Returns `None` on Windows and Linux for now — the macOS path covers the
//! first-class platform; Windows requires the `windows` crate which isn't
//! currently a dep, and Linux has no portable accent-color concept.

#[tauri::command]
pub fn get_system_accent_color() -> Option<String> {
    get_accent_color_inner()
}

#[cfg(target_os = "macos")]
fn get_accent_color_inner() -> Option<String> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let ns_color: id = msg_send![class!(NSColor), controlAccentColor];
        if ns_color == nil {
            return None;
        }

        // Force conversion to sRGB before reading components — NSColor in its
        // native space (genericRGB / displayP3) reports values that don't map
        // cleanly to #rrggbb. sRGB is what CSS expects.
        let srgb_space: id = msg_send![class!(NSColorSpace), sRGBColorSpace];
        let converted: id = msg_send![ns_color, colorUsingColorSpace: srgb_space];
        if converted == nil {
            return None;
        }

        let r: f64 = msg_send![converted, redComponent];
        let g: f64 = msg_send![converted, greenComponent];
        let b: f64 = msg_send![converted, blueComponent];

        Some(format!(
            "#{:02x}{:02x}{:02x}",
            (r.clamp(0.0, 1.0) * 255.0).round() as u8,
            (g.clamp(0.0, 1.0) * 255.0).round() as u8,
            (b.clamp(0.0, 1.0) * 255.0).round() as u8
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn get_accent_color_inner() -> Option<String> {
    None
}
