use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const SUBDIR: &str = "acp-stream";

fn acp_stream_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("app_log_dir: {e}"))?;
    let dir = base.join(SUBDIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
}

fn safe_session_filename(session_id: &str) -> String {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return "_global.log".to_string();
    }
    let safe: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}.log")
}

fn append_to(path: &Path, text: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    file.flush()
        .map_err(|e| format!("flush {}: {e}", path.display()))?;
    Ok(())
}

/// Append one formatted ACP debug block (session file + combined log).
#[tauri::command]
pub fn acp_debug_append_log(
    app: AppHandle,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let dir = acp_stream_log_dir(&app)?;
    let session_path = dir.join(safe_session_filename(&session_id));
    let combined_path = dir.join("_all.log");
    append_to(&session_path, &text)?;
    append_to(&combined_path, &text)?;
    Ok(())
}

/// Directory where ACP stream logs are written (`app_log_dir/acp-stream`).
#[tauri::command]
pub fn acp_debug_log_directory(app: AppHandle) -> Result<String, String> {
    let dir = acp_stream_log_dir(&app)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Reveal the session log file (or the log directory when session id is empty).
#[tauri::command]
pub fn acp_debug_reveal_log(app: AppHandle, session_id: Option<String>) -> Result<(), String> {
    let dir = acp_stream_log_dir(&app)?;
    let session_id = session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    match session_id {
        Some(id) => {
            let file = dir.join(safe_session_filename(id));
            if !file.exists() {
                std::fs::write(&file, "").map_err(|e| format!("create {}: {e}", file.display()))?;
            }
            crate::commands::show_in_folder(file.to_string_lossy().into_owned())
        }
        None => open_path_in_file_manager(&dir),
    }
}

fn open_path_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open in Finder: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open in Explorer: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open in file manager: {e}"))?;
    }
    Ok(())
}
