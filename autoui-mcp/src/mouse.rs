use anyhow::{Context, Result};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Mouse, Settings};
use std::thread;
use std::time::Duration;

/// Click the mouse at `(x, y)` in logical (screen) coordinates.
pub fn click(x: i32, y: i32, button: &str, clicks: u32) -> Result<String> {
    let mut enigo = Enigo::new(&Settings::default()).context("Failed to create Enigo instance")?;

    let btn = match button {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    };

    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .context("move_mouse failed")?;

    // Wait 0.5s before nudging to let the UI settle
    thread::sleep(Duration::from_millis(500));

    // Nudge 2px to the left to compensate for coordinate offset
    enigo
        .move_mouse(x - 2, y, Coordinate::Abs)
        .context("move_mouse nudge left failed")?;

    for _ in 0..clicks {
        enigo
            .button(btn, Direction::Click)
            .context("button click failed")?;
        thread::sleep(Duration::from_millis(50));
    }

    Ok(format!(
        "Clicked {button} ({x},{y}) x{clicks}."
    ))
}

/// Move the mouse to `(x, y)`.
pub fn move_to(x: i32, y: i32) -> Result<String> {
    let mut enigo = Enigo::new(&Settings::default()).context("Failed to create Enigo instance")?;

    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .context("move_mouse failed")?;

    Ok(format!(
        "Moved to ({x},{y})."
    ))
}

/// Scroll the mouse wheel.  Positive `amount` = up, negative = down.
/// Optionally click at `(x, y)` first to focus.
pub fn scroll(amount: i32, focus: Option<(i32, i32)>) -> Result<String> {
    let mut enigo = Enigo::new(&Settings::default()).context("Failed to create Enigo instance")?;

    if let Some((x, y)) = focus {
        enigo
            .move_mouse(x, y, Coordinate::Abs)
            .context("move_mouse (focus) failed")?;
        enigo
            .button(Button::Left, Direction::Click)
            .context("focus click failed")?;
        thread::sleep(Duration::from_millis(100));
    }

    enigo
        .scroll(amount, Axis::Vertical)
        .context("scroll failed")?;

    let direction = if amount < 0 { "down" } else { "up" };
    Ok(format!(
        "Scrolled {direction} {}.",
        amount.unsigned_abs()
    ))
}

/// Drag from `(sx, sy)` to `(ex, ey)`.
pub fn drag(sx: i32, sy: i32, ex: i32, ey: i32) -> Result<String> {
    let mut enigo = Enigo::new(&Settings::default()).context("Failed to create Enigo instance")?;

    // Move to start position
    enigo
        .move_mouse(sx, sy, Coordinate::Abs)
        .context("move to start failed")?;
    thread::sleep(Duration::from_millis(50));

    // Press down
    enigo
        .button(Button::Left, Direction::Press)
        .context("mouse down failed")?;
    thread::sleep(Duration::from_millis(50));

    // Smooth drag: interpolate in small steps
    let steps = 20;
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let cx = sx as f64 + (ex - sx) as f64 * t;
        let cy = sy as f64 + (ey - sy) as f64 * t;
        enigo
            .move_mouse(cx as i32, cy as i32, Coordinate::Abs)
            .context("drag move failed")?;
        thread::sleep(Duration::from_millis(15));
    }

    thread::sleep(Duration::from_millis(50));

    // Release
    enigo
        .button(Button::Left, Direction::Release)
        .context("mouse up failed")?;

    Ok(format!(
        "Dragged ({sx},{sy})->({ex},{ey})."
    ))
}
