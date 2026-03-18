use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::Manager;
use tauri::State;

use crate::stt::{list_models, run_pipeline_streaming, stt_models_dir, SttState};

const HF_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

fn downloadable_models() -> Vec<(String, String, String, String)> {
    vec![
        ("tiny".to_string(), "ggml-tiny.bin".to_string(), "~75 MB".to_string(), "Tiny (fastest)".to_string()),
        ("base".to_string(), "ggml-base.bin".to_string(), "~142 MB".to_string(), "Base".to_string()),
        ("small".to_string(), "ggml-small.bin".to_string(), "~466 MB".to_string(), "Small (recommended)".to_string()),
        ("medium".to_string(), "ggml-medium.bin".to_string(), "~1.5 GB".to_string(), "Medium (better accuracy)".to_string()),
        ("large-v3".to_string(), "ggml-large-v3.bin".to_string(), "~2.9 GB".to_string(), "Large v3 (best accuracy)".to_string()),
    ]
}

#[tauri::command]
pub fn stt_is_available(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let models_dir = match stt_models_dir(&app_handle) {
        Ok(d) => d,
        Err(e) => {
            return Ok(serde_json::json!({
                "available": false,
                "reason": e
            }));
        }
    };
    let models = list_models(&models_dir).unwrap_or_default();
    let has_models = !models.is_empty();
    #[cfg(feature = "stt-whisper")]
    let available = has_models;
    #[cfg(not(feature = "stt-whisper"))]
    let available = false;
    Ok(serde_json::json!({
        "available": available,
        "reason": if available { serde_json::Value::Null } else if !has_models { serde_json::json!("Place a Whisper .bin model (e.g. ggml-small.bin) in the app's stt_models folder.") } else { serde_json::json!("Build with --features stt-whisper to enable offline transcription.") }
    }))
}

#[tauri::command]
pub fn stt_start_listening(
    app_handle: tauri::AppHandle,
    state: State<'_, SttState>,
    language: Option<String>,
) -> Result<(), String> {
    if state.listening.swap(true, Ordering::SeqCst) {
        return Err("Already listening".to_string());
    }
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut guard = state.stop.lock().map_err(|e| e.to_string())?;
        *guard = Some(Arc::clone(&stop));
    }
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        run_pipeline_streaming(&handle, stop, language);
        if let Some(s) = handle.try_state::<SttState>() {
            s.listening.store(false, Ordering::SeqCst);
            if let Ok(mut g) = s.stop.lock() {
                *g = None;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn stt_stop_listening(state: State<'_, SttState>) -> Result<(), String> {
    state.listening.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = state.stop.lock() {
        if let Some(stop) = guard.take() {
            stop.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn stt_list_downloadable_models(app_handle: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let models_dir = stt_models_dir(&app_handle).ok();
    let installed = models_dir
        .as_ref()
        .and_then(|d| list_models(d).ok())
        .unwrap_or_default();
    let list: Vec<serde_json::Value> = downloadable_models()
        .into_iter()
        .map(|(id, file, size, name)| {
            let installed = installed.contains(&file);
            serde_json::json!({
                "id": id,
                "name": name,
                "file": file,
                "size": size,
                "installed": installed,
            })
        })
        .collect();
    Ok(list)
}

#[tauri::command]
pub fn stt_download_model(app_handle: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let (_, file, _, _) = downloadable_models()
        .into_iter()
        .find(|(id, _, _, _)| id == &model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;
    let models_dir = stt_models_dir(&app_handle)?;
    std::fs::create_dir_all(&models_dir).map_err(|e| format!("Create models dir: {}", e))?;
    let dest_path = models_dir.join(&file);
    if dest_path.exists() {
        return Err(format!("Model already installed: {}", file));
    }
    let url = format!("{}/{}", HF_BASE, file);
    let resp = reqwest::blocking::get(&url)
        .map_err(|e| format!("Download request: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Download failed: {}", e))?;
    let mut dest_file =
        std::fs::File::create(&dest_path).map_err(|e| format!("Create file: {}", e))?;
    let mut content = resp;
    std::io::copy(&mut content, &mut dest_file).map_err(|e| format!("Write file: {}", e))?;
    Ok(())
}
