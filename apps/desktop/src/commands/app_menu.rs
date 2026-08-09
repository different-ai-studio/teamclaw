//! Native application menu bar (macOS TeamClu / File / Edit / …).
//!
//! Replaces Tauri's default menu so we can:
//! - use the product brand name (not Cargo package `teamclu`) in About/Hide/Quit
//! - add Settings… with ⌘, that opens the in-app Settings dialog

use std::sync::Mutex;

use tauri::{
    menu::{
        AboutMetadata, Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu,
        HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    },
    AppHandle, Emitter, Manager, State, Wry,
};

use crate::branding;

pub const APP_SETTINGS_ID: &str = "app_settings";
pub const OPEN_SETTINGS_EVENT: &str = "open-app-settings";

pub struct AppMenuState {
    pub settings: Mutex<MenuItem<Wry>>,
}

impl AppMenuState {
    pub fn new(settings: MenuItem<Wry>) -> Self {
        Self {
            settings: Mutex::new(settings),
        }
    }
}

fn prefers_zh_locale() -> bool {
    let hint = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default()
        .to_lowercase();
    hint.starts_with("zh") || hint.contains(".zh") || hint.contains("_zh")
}

fn settings_label_cold_start() -> &'static str {
    if prefers_zh_locale() {
        "设置…"
    } else {
        "Settings…"
    }
}

/// Build the app-wide menu and install it. Returns the Settings item so callers
/// can keep a handle for locale updates.
pub fn install_app_menu(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let brand = branding::brand_name(app.config().product_name.as_deref());
    let version = app.package_info().version.to_string();
    let about_metadata = AboutMetadata {
        name: Some(brand.clone()),
        version: Some(version),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let settings = MenuItemBuilder::with_id(APP_SETTINGS_ID, settings_label_cold_start())
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, None, Some(about_metadata.clone()))?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let app_submenu = Submenu::with_items(
        app,
        &brand,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&format!("About {brand}")), Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&format!("Hide {brand}")))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&format!("Quit {brand}")))?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &app_submenu,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    #[cfg(not(target_os = "macos"))]
                    &settings,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(app, Some(&format!("Quit {brand}")))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )?;

    let _ = app.set_menu(menu)?;
    Ok(settings)
}

/// Show the main window and ask the frontend to open Settings.
pub fn open_app_settings(app: &AppHandle) {
    let state = app.state::<super::window_chrome::MainWindowState>();
    super::window_chrome::show_main_window(app.clone(), state);
    if let Err(e) = app.emit(OPEN_SETTINGS_EVENT, ()) {
        eprintln!("[app-menu] emit {OPEN_SETTINGS_EVENT}: {e}");
    }
}

#[tauri::command]
pub fn update_app_menu_labels(
    state: State<'_, AppMenuState>,
    settings: String,
) -> Result<(), String> {
    state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .set_text(settings)
        .map_err(|e| e.to_string())
}
