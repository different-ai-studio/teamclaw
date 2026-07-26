//! System tray menu labels — updated from the frontend when UI locale changes.

use std::sync::Mutex;

use tauri::{menu::MenuItem, State};

pub struct TrayMenuState {
    pub show_main: Mutex<MenuItem<tauri::Wry>>,
    pub agent_settings: Mutex<MenuItem<tauri::Wry>>,
    pub quit: Mutex<MenuItem<tauri::Wry>>,
}

impl TrayMenuState {
    pub fn new(
        show_main: MenuItem<tauri::Wry>,
        agent_settings: MenuItem<tauri::Wry>,
        quit: MenuItem<tauri::Wry>,
    ) -> Self {
        Self {
            show_main: Mutex::new(show_main),
            agent_settings: Mutex::new(agent_settings),
            quit: Mutex::new(quit),
        }
    }
}

/// Replace tray menu item texts with the current UI locale strings.
#[tauri::command]
pub fn update_tray_menu_labels(
    state: State<'_, TrayMenuState>,
    show_main: String,
    agent_settings: String,
    quit: String,
) -> Result<(), String> {
    state
        .show_main
        .lock()
        .map_err(|e| e.to_string())?
        .set_text(show_main)
        .map_err(|e| e.to_string())?;
    state
        .agent_settings
        .lock()
        .map_err(|e| e.to_string())?
        .set_text(agent_settings)
        .map_err(|e| e.to_string())?;
    state
        .quit
        .lock()
        .map_err(|e| e.to_string())?
        .set_text(quit)
        .map_err(|e| e.to_string())?;
    Ok(())
}
