use anyhow::{Context, Result};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::thread;
use std::time::Duration;

use crate::keys;

/// Type arbitrary text.
///
/// - Pure ASCII is typed via [`Keyboard::text`] which is reliable and fast.
/// - Text containing non-ASCII (e.g. Chinese) is pasted via the system
///   clipboard so it works regardless of the input method.
pub fn type_text(text: &str, _interval: f64) -> Result<String> {
    let is_ascii = text.chars().all(|c| c.is_ascii());

    if is_ascii {
        let mut enigo =
            Enigo::new(&Settings::default()).context("Failed to create Enigo instance")?;
        enigo.text(text).context("enigo.text() failed")?;
    } else {
        paste_via_clipboard(text)?;
    }

    let preview = if text.len() > 50 {
        format!("{}...", &text[..text.char_indices().nth(50).map(|(i, _)| i).unwrap_or(text.len())])
    } else {
        text.to_string()
    };
    Ok(format!(
        "Typed: {preview}."
    ))
}

/// Press one or more keys described by a combo string like `"ctrl+c"`.
pub fn press_keys(combo_str: &str) -> Result<String> {
    let combo = keys::parse_combo(combo_str)
        .with_context(|| format!("Unknown key in combo: {combo_str}"))?;

    let mut enigo =
        Enigo::new(&Settings::default()).context("Failed to create Enigo instance")?;

    // Press all keys down in order
    for key in &combo {
        enigo
            .key(*key, Direction::Press)
            .with_context(|| format!("key press failed: {key:?}"))?;
        thread::sleep(Duration::from_millis(20));
    }

    // Release in reverse order
    for key in combo.iter().rev() {
        enigo
            .key(*key, Direction::Release)
            .with_context(|| format!("key release failed: {key:?}"))?;
        thread::sleep(Duration::from_millis(20));
    }

    Ok(format!(
        "Pressed: {combo_str}."
    ))
}

// ---------------------------------------------------------------------------
// Clipboard paste helper
// ---------------------------------------------------------------------------

fn paste_via_clipboard(text: &str) -> Result<()> {
    use arboard::Clipboard;

    let mut clipboard = Clipboard::new().context("Failed to open clipboard")?;

    // Save current clipboard content (best-effort)
    let old_text = clipboard.get_text().ok();

    // Write new text
    clipboard
        .set_text(text.to_string())
        .context("Failed to set clipboard text")?;

    // Small delay to let the clipboard settle
    thread::sleep(Duration::from_millis(50));

    // Simulate Cmd+V (macOS) or Ctrl+V (others)
    let mut enigo =
        Enigo::new(&Settings::default()).context("Failed to create Enigo instance")?;

    let modifier = if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    };

    enigo
        .key(modifier, Direction::Press)
        .context("modifier press failed")?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .context("v click failed")?;
    enigo
        .key(modifier, Direction::Release)
        .context("modifier release failed")?;

    // Wait for paste to complete
    thread::sleep(Duration::from_millis(150));

    // Restore old clipboard (best-effort)
    if let Some(old) = old_text {
        let _ = clipboard.set_text(old);
    }

    Ok(())
}
