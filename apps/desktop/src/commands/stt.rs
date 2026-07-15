use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;

use tauri::Emitter;
use tauri::Manager;
use tauri::State;

use teamclaw_stt::{run_pipeline_streaming, SttState};

/// Compute the STT models directory from the Tauri app handle.
fn stt_models_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join("stt_models"))
}

const HF_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const INSTALLED_MIN_RATIO_NUM: u64 = 90;
const INSTALLED_MIN_RATIO_DEN: u64 = 100;

fn expected_model_bytes(model_id: &str) -> Option<u64> {
    // Values are derived from the existing UI hints (~MB/~GB).
    // Used only to detect partial/corrupted downloads on disk.
    const MB: u64 = 1024 * 1024;
    const GB: u64 = 1024 * 1024 * 1024;
    match model_id {
        "tiny" => Some(75 * MB),
        "base" => Some(142 * MB),
        "small" => Some(466 * MB),
        "medium" => Some((15 * GB) / 10),   // ~1.5 GB
        "large-v3" => Some((29 * GB) / 10), // ~2.9 GB
        _ => None,
    }
}

fn downloadable_models() -> Vec<(String, String, String, String, u64)> {
    // (id, file, size_label, display_name, expected_bytes)
    vec![
        (
            "tiny".to_string(),
            "ggml-tiny.bin".to_string(),
            "~75 MB".to_string(),
            "Tiny (fastest)".to_string(),
            expected_model_bytes("tiny").unwrap(),
        ),
        (
            "base".to_string(),
            "ggml-base.bin".to_string(),
            "~142 MB".to_string(),
            "Base".to_string(),
            expected_model_bytes("base").unwrap(),
        ),
        (
            "small".to_string(),
            "ggml-small.bin".to_string(),
            "~466 MB".to_string(),
            "Small (recommended)".to_string(),
            expected_model_bytes("small").unwrap(),
        ),
        (
            "medium".to_string(),
            "ggml-medium.bin".to_string(),
            "~1.5 GB".to_string(),
            "Medium (better accuracy)".to_string(),
            expected_model_bytes("medium").unwrap(),
        ),
        (
            "large-v3".to_string(),
            "ggml-large-v3.bin".to_string(),
            "~2.9 GB".to_string(),
            "Large v3 (best accuracy)".to_string(),
            expected_model_bytes("large-v3").unwrap(),
        ),
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
    let has_models = downloadable_models()
        .into_iter()
        .any(|(_, file, _, _, expected_bytes)| {
            let p = models_dir.join(&file);
            std::fs::metadata(p)
                .ok()
                .map(|m| {
                    m.len() * INSTALLED_MIN_RATIO_DEN >= expected_bytes * INSTALLED_MIN_RATIO_NUM
                })
                .unwrap_or(false)
        });
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
    let models_dir = stt_models_dir(&app_handle)?;
    std::thread::spawn(move || {
        let emit_handle = handle.clone();
        let on_event: teamclaw_stt::EventEmitter = Box::new(move |event, payload| {
            let _ = emit_handle.emit(event, payload);
        });
        run_pipeline_streaming(on_event, models_dir, stop, language);
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
pub fn stt_list_downloadable_models(
    app_handle: tauri::AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    let models_dir = stt_models_dir(&app_handle).ok();
    let list: Vec<serde_json::Value> = downloadable_models()
        .into_iter()
        .map(|(id, file, size_label, display_name, expected_bytes)| {
            let installed = models_dir
                .as_ref()
                .and_then(|dir| {
                    let p = dir.join(&file);
                    std::fs::metadata(p).ok().map(|m| {
                        m.len() * INSTALLED_MIN_RATIO_DEN
                            >= expected_bytes * INSTALLED_MIN_RATIO_NUM
                    })
                })
                .unwrap_or(false);

            serde_json::json!({
                "id": id,
                "name": display_name,
                "file": file,
                "size": size_label,
                "installed": installed,
            })
        })
        .collect();
    Ok(list)
}

const DOWNLOAD_CHUNK: usize = 64 * 1024;
// Emit less frequently when `Content-Length` is missing.
// If we emit per small chunk, React re-renders too often and can cause UI jank.
const PROGRESS_EMIT_INTERVAL: u64 = 2 * 1024 * 1024; // emit every 2 MB

#[tauri::command]
pub fn stt_download_model(app_handle: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let (_, file, _, _, expected_bytes) = downloadable_models()
        .into_iter()
        .find(|(id, _, _, _, _)| id == &model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;
    let models_dir = stt_models_dir(&app_handle)?;
    std::fs::create_dir_all(&models_dir).map_err(|e| format!("Create models dir: {}", e))?;
    let dest_path = models_dir.join(&file);
    if dest_path.exists() {
        // If it doesn't reach the expected size ratio, it's likely a partial download.
        let is_partial = dest_path
            .metadata()
            .ok()
            .map(|m| m.len() * INSTALLED_MIN_RATIO_DEN < expected_bytes * INSTALLED_MIN_RATIO_NUM)
            .unwrap_or(true);

        if !is_partial {
            return Err(format!("Model already installed: {}", file));
        }
        let _ = std::fs::remove_file(&dest_path);
    }
    let url = format!("{}/{}", HF_BASE, file);
    let handle = app_handle.clone();
    let model_id_for_thread = model_id.clone();
    let dest_path_for_thread = dest_path.clone();
    let temp_path_for_thread = dest_path_for_thread.with_extension("part");

    // Start download in background so the invoke() call doesn't block the UI.
    thread::spawn(move || {
        println!(
            "[STT] start downloading model={} file={} -> {}",
            model_id_for_thread,
            file,
            dest_path_for_thread.display()
        );
        let res: Result<(), String> = (|| {
            let mut resp = reqwest::blocking::get(&url)
                .map_err(|e| format!("Download request: {}", e))?
                .error_for_status()
                .map_err(|e| format!("Download failed: {}", e))?;
            let total_bytes = resp.content_length();
            // Write to a temp file first, then rename on success.
            // This prevents partially downloaded files from being detected as "installed".
            if temp_path_for_thread.exists() {
                std::fs::remove_file(&temp_path_for_thread)
                    .map_err(|e| format!("Remove temp file: {}", e))?;
            }
            let mut dest_file = std::fs::File::create(&temp_path_for_thread)
                .map_err(|e| format!("Create temp file: {}", e))?;

            let mut buf = [0u8; DOWNLOAD_CHUNK];
            let mut bytes_downloaded: u64 = 0;
            let mut last_emit_bytes: u64 = 0;
            let mut last_emit_pct: u64 = 101;

            loop {
                let n = resp
                    .read(&mut buf)
                    .map_err(|e| format!("Read response: {}", e))?;
                if n == 0 {
                    break;
                }
                std::io::Write::write_all(&mut dest_file, &buf[..n])
                    .map_err(|e| format!("Write file: {}", e))?;
                bytes_downloaded += n as u64;

                let pct = total_bytes
                    .and_then(|t| (bytes_downloaded * 100).min(100).checked_div(t))
                    .unwrap_or(0);
                let emit_by_interval =
                    bytes_downloaded.saturating_sub(last_emit_bytes) >= PROGRESS_EMIT_INTERVAL;
                let emit_by_pct = total_bytes.is_some() && pct != last_emit_pct;

                if emit_by_interval || emit_by_pct {
                    last_emit_bytes = bytes_downloaded;
                    last_emit_pct = pct;
                    let _ = handle.emit(
                        "stt:download_progress",
                        serde_json::json!({
                            "modelId": model_id_for_thread,
                            "bytesDownloaded": bytes_downloaded,
                            "totalBytes": total_bytes,
                        }),
                    );
                }
            }

            // final progress event
            let _ = handle.emit(
                "stt:download_progress",
                serde_json::json!({
                    "modelId": model_id_for_thread,
                    "bytesDownloaded": bytes_downloaded,
                    "totalBytes": total_bytes,
                }),
            );

            dest_file
                .sync_all()
                .map_err(|e| format!("Sync temp file: {}", e))?;

            // Rename temp -> final
            if dest_path_for_thread.exists() {
                std::fs::remove_file(&dest_path_for_thread)
                    .map_err(|e| format!("Remove existing model file: {}", e))?;
            }
            std::fs::rename(&temp_path_for_thread, &dest_path_for_thread)
                .map_err(|e| format!("Rename temp file: {}", e))?;

            Ok(())
        })();

        match res {
            Ok(()) => {
                println!("[STT] finished downloading model={}", model_id_for_thread);
                let _ = handle.emit(
                    "stt:download_finished",
                    serde_json::json!({ "modelId": model_id_for_thread }),
                );
            }
            Err(message) => {
                println!(
                    "[STT] download failed model={} message={}",
                    model_id_for_thread, message
                );
                // Best-effort cleanup of temp file.
                if temp_path_for_thread.exists() {
                    let _ = std::fs::remove_file(&temp_path_for_thread);
                }
                let _ = handle.emit(
                    "stt:download_error",
                    serde_json::json!({ "modelId": model_id_for_thread, "message": message }),
                );
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn stt_delete_model(app_handle: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let (_, file, _, _, _) = downloadable_models()
        .into_iter()
        .find(|(id, _, _, _, _)| id == &model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;
    let models_dir = stt_models_dir(&app_handle)?;
    let dest_path = models_dir.join(&file);
    if !dest_path.exists() {
        return Err(format!("Model not installed: {}", file));
    }
    std::fs::remove_file(&dest_path).map_err(|e| format!("Remove model {}: {}", file, e))?;
    // Also remove any stale temp download file.
    let temp_path = dest_path.with_extension("part");
    if temp_path.exists() {
        let _ = std::fs::remove_file(&temp_path);
    }
    Ok(())
}
