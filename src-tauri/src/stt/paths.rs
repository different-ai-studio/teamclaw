use std::path::PathBuf;

use tauri::{Manager, Runtime};

pub fn stt_models_dir<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join("stt_models"))
}
