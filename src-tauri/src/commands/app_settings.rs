use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

const SETTINGS_FILE_NAME: &str = "app-settings.json";
const SPOTLIGHT_SHORTCUT_KEY: &str = "spotlightShortcut";
pub const DEFAULT_SPOTLIGHT_SHORTCUT: &str = "alt+space";

pub struct SpotlightShortcutState {
    current: Mutex<String>,
}

impl SpotlightShortcutState {
    pub fn new(shortcut: String) -> Self {
        Self {
            current: Mutex::new(shortcut),
        }
    }

    pub fn current(&self) -> String {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

fn settings_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(super::TEAMCLAW_DIR)
        .join(SETTINGS_FILE_NAME)
}

fn read_settings_value() -> Value {
    let path = settings_path();
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Value::Object(Map::new());
    };
    serde_json::from_str(&content).unwrap_or_else(|_| Value::Object(Map::new()))
}

fn write_spotlight_shortcut_setting(shortcut: &str) -> Result<(), String> {
    let mut settings = match read_settings_value() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    settings.insert(
        SPOTLIGHT_SHORTCUT_KEY.to_string(),
        Value::String(shortcut.to_string()),
    );

    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings directory: {e}"))?;
    }
    let content = serde_json::to_string_pretty(&Value::Object(settings))
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write settings: {e}"))
}

pub fn normalize_spotlight_shortcut(shortcut: &str) -> Result<String, String> {
    let trimmed = shortcut.trim();
    if trimmed.is_empty() {
        return Err("Shortcut cannot be empty".to_string());
    }

    let mut parts = Vec::new();
    for raw in trimmed.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            return Err("Shortcut contains an empty token".to_string());
        }

        let lower = token.to_ascii_lowercase();
        let normalized = match lower.as_str() {
            "option" => "alt".to_string(),
            "command" => "cmd".to_string(),
            "control" => "ctrl".to_string(),
            "commandorcontrol" | "commandorctrl" | "cmdorcontrol" => "cmdorctrl".to_string(),
            _ => lower,
        };
        parts.push(normalized);
    }

    let normalized = parts.join("+");
    let _: Shortcut = normalized
        .parse()
        .map_err(|e| format!("Invalid shortcut '{normalized}': {e}"))?;
    Ok(normalized)
}

pub fn read_spotlight_shortcut() -> String {
    read_settings_value()
        .get(SPOTLIGHT_SHORTCUT_KEY)
        .and_then(Value::as_str)
        .and_then(|shortcut| normalize_spotlight_shortcut(shortcut).ok())
        .unwrap_or_else(|| DEFAULT_SPOTLIGHT_SHORTCUT.to_string())
}

pub fn register_spotlight_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let normalized = normalize_spotlight_shortcut(shortcut)?;
    if app.global_shortcut().is_registered(normalized.as_str()) {
        return Ok(());
    }
    app.global_shortcut()
        .register(normalized.as_str())
        .map_err(|e| format!("Failed to register shortcut: {e}"))
}

#[tauri::command]
pub fn get_spotlight_shortcut(state: State<'_, SpotlightShortcutState>) -> String {
    state.current()
}

#[tauri::command]
pub fn set_spotlight_shortcut(
    app: AppHandle,
    state: State<'_, SpotlightShortcutState>,
    shortcut: String,
) -> Result<String, String> {
    let normalized = normalize_spotlight_shortcut(&shortcut)?;
    let mut current = state.current.lock().unwrap_or_else(|e| e.into_inner());
    if *current == normalized {
        write_spotlight_shortcut_setting(&normalized)?;
        return Ok(normalized);
    }

    let previous = current.clone();
    let previous_registered =
        !previous.is_empty() && app.global_shortcut().is_registered(previous.as_str());

    if previous_registered {
        app.global_shortcut()
            .unregister(previous.as_str())
            .map_err(|e| format!("Failed to unregister previous shortcut: {e}"))?;
    }

    if let Err(err) = app.global_shortcut().register(normalized.as_str()) {
        if previous_registered {
            let _ = app.global_shortcut().register(previous.as_str());
        }
        return Err(format!("Failed to register shortcut: {err}"));
    }

    if let Err(err) = write_spotlight_shortcut_setting(&normalized) {
        let _ = app.global_shortcut().unregister(normalized.as_str());
        if previous_registered {
            let _ = app.global_shortcut().register(previous.as_str());
        }
        return Err(err);
    }

    *current = normalized.clone();
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_option_alias() {
        assert_eq!(
            normalize_spotlight_shortcut(" Option + Space ").unwrap(),
            "alt+space"
        );
    }

    #[test]
    fn normalizes_command_alias() {
        assert_eq!(
            normalize_spotlight_shortcut("Command + Shift + P").unwrap(),
            "cmd+shift+p"
        );
    }

    #[test]
    fn rejects_empty_shortcuts() {
        assert!(normalize_spotlight_shortcut("").is_err());
        assert!(normalize_spotlight_shortcut("alt+").is_err());
    }
}
