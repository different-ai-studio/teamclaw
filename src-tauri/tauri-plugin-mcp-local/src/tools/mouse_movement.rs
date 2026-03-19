use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::Error;
use crate::models::MouseMovementRequest;
use crate::shared::{MouseMovementParams, MouseMovementResult};
use crate::socket_server::SocketResponse;
use enigo::{Button, Coordinate, Direction, Enigo, Mouse, Settings};
use std::time::Instant;
use log::info;

pub async fn simulate_mouse_movement_async<R: Runtime>(
    app: &AppHandle<R>,
    params: MouseMovementRequest,
) -> crate::Result<crate::models::MouseMovementResponse> {
    info!(
        "[MOUSE_MOVEMENT] Starting mouse movement with params: {:?}",
        params
    );

    // Get the window reference
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| Error::window_not_found("main"))?;

    // Get window position (outer includes window borders/decorations)
    let window_position = window
        .outer_position()
        .map_err(|e| Error::window_operation_failed("get window position", format!("{}", e)))?;
    info!(
        "[MOUSE_MOVEMENT] Window outer position: {:?}",
        window_position
    );

    // Also get inner position for comparison
    let window_inner_position = window
        .inner_position()
        .map_err(|e| Error::window_operation_failed("get window inner position", format!("{}", e)))?;
    info!(
        "[MOUSE_MOVEMENT] Window inner position: {:?}",
        window_inner_position
    );

    // Get window size for reference
    let window_size = window
        .inner_size()
        .map_err(|e| Error::window_operation_failed("get window size", format!("{}", e)))?;
    info!("[MOUSE_MOVEMENT] Window inner size: {:?}", window_size);

    // Get window scale factor for high DPI screens
    let scale_factor = window
        .scale_factor()
        .map_err(|e| Error::window_operation_failed("get window scale factor", format!("{}", e)))?;
    info!("[MOUSE_MOVEMENT] Window scale factor: {}", scale_factor);

    let x = params.x;
    let y = params.y;
    let relative = params.relative.unwrap_or(false);
    let click = params.click.unwrap_or(false);
    let button_type = params.button.as_deref().unwrap_or("left");

    info!(
        "[MOUSE_MOVEMENT] Input coordinates: x={}, y={}, relative={}",
        x, y, relative
    );

    // Create Enigo instance
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| Error::communication_error(format!("Failed to initialize Enigo: {}", e)))?;

    // Get current mouse position for reference
    let current_position = Mouse::location(&enigo)
        .map_err(|e| Error::communication_error(format!("Failed to get current mouse position: {}", e)))?;
    info!(
        "[MOUSE_MOVEMENT] Current mouse position before move: ({}, {})",
        current_position.0, current_position.1
    );

    let start_time = Instant::now();

    // Calculate actual screen coordinates only if not relative
    let (screen_x, screen_y) = if relative {
        info!("[MOUSE_MOVEMENT] Using relative movement, no coordinate transformation");
        (x, y) // Keep as is for relative movements
    } else {
        // Adjust for window position and scale factor
        let scaled_x = (x as f64 * scale_factor) as i32;
        let scaled_y = (y as f64 * scale_factor) as i32;

        info!("[MOUSE_MOVEMENT] Coordinate transformation:");
        info!("[MOUSE_MOVEMENT] 1. Original coordinates: ({}, {})", x, y);
        info!(
            "[MOUSE_MOVEMENT] 2. After scale factor ({}): ({}, {})",
            scale_factor, scaled_x, scaled_y
        );

        let final_x = scaled_x + window_position.x;
        let final_y = scaled_y + window_position.y;
        info!(
            "[MOUSE_MOVEMENT] 3. After adding window position ({}, {}): ({}, {})",
            window_position.x, window_position.y, final_x, final_y
        );

        // Calculate what it would be with inner position for comparison
        let inner_x = scaled_x + window_inner_position.x;
        let inner_y = scaled_y + window_inner_position.y;
        info!(
            "[MOUSE_MOVEMENT] (Alternative with inner position: ({}, {}))",
            inner_x, inner_y
        );

        (final_x, final_y)
    };

    info!(
        "[MOUSE_MOVEMENT] Final screen coordinates for mouse: ({}, {})",
        screen_x, screen_y
    );

    // Use calculated screen coordinates
    let coordinate_type = if relative {
        Coordinate::Rel
    } else {
        Coordinate::Abs
    };

    Mouse::move_mouse(&mut enigo, screen_x, screen_y, coordinate_type)
        .map_err(|e| Error::communication_error(format!("Failed to move mouse: {}", e)))?;

    // Perform click if requested
    if click {
        // Convert string button type to Button enum
        let button = match button_type {
            "right" => Button::Right,
            "middle" => Button::Middle,
            _ => Button::Left, // Default to left button
        };

        info!("[MOUSE_MOVEMENT] Clicking with {} button", button_type);

        // Perform click (press and release)
        Mouse::button(&mut enigo, button, Direction::Press)
            .map_err(|e| Error::communication_error(format!("Failed to press mouse button: {}", e)))?;

        Mouse::button(&mut enigo, button, Direction::Release)
            .map_err(|e| Error::communication_error(format!("Failed to release mouse button: {}", e)))?;
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;

    // Get current position after movement
    let position = Mouse::location(&enigo)
        .map_err(|e| Error::communication_error(format!("Failed to get mouse position: {}", e)))?;
    info!(
        "[MOUSE_MOVEMENT] Final mouse position after move: ({}, {})",
        position.0, position.1
    );

    Ok(crate::models::MouseMovementResponse {
        success: true,
        duration_ms,
        position: Some(position),
    })
}

pub fn simulate_mouse_movement_shared<R: Runtime>(
    app: &AppHandle<R>,
    params: MouseMovementParams,
) -> std::result::Result<MouseMovementResult, String> {
    // Use the current tokio runtime handle instead of creating a new one
    let handle = tokio::runtime::Handle::current();

    // Convert shared params to internal type
    let request = MouseMovementRequest {
        x: params.x,
        y: params.y,
        relative: params.relative,
        click: params.click,
        button: params.button,
    };

    // Run async method
    let result = handle.block_on(simulate_mouse_movement_async(app, request));

    // Convert result to shared type
    match result {
        Ok(response) => Ok(MouseMovementResult {
            success: true,
            duration_ms: response.duration_ms,
            position: response.position,
            error: None,
        }),
        Err(e) => Ok(MouseMovementResult {
            success: false,
            duration_ms: 0,
            position: None,
            error: Some(e.to_string()),
        }),
    }
}

pub async fn handle_simulate_mouse_movement<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    // Parse the payload
    let params: MouseMovementRequest = serde_json::from_value(payload)
        .map_err(|e| Error::serialization_error(format!("Invalid payload for simulateMouseMovement: {}", e)))?;

    // Call the async method
    let result = simulate_mouse_movement_async(app, params).await;

    match result {
        Ok(response) => {
            let data = serde_json::to_value(response)
                .map_err(|e| Error::serialization_error(format!("Failed to serialize response: {}", e)))?;
            Ok(SocketResponse {
                success: true,
                data: Some(data),
                error: None,
            })
        }
        Err(e) => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(e.to_string()),
        }),
    }
}
