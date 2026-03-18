use std::path::{Path, PathBuf};

/// Default model filename for first available or download.
#[allow(dead_code)]
pub const DEFAULT_MODEL_NAME: &str = "ggml-small.bin";

#[cfg(feature = "stt-whisper")]
use whisper_rs::{WhisperContext, WhisperContextParameters};

#[cfg(feature = "stt-whisper")]
/// Load a Whisper model from the given path (path to .bin file or dir containing it).
pub fn load_model(models_dir: &Path, model_name: &str) -> Result<WhisperContext, String> {
    let path = models_dir.join(model_name);
    if !path.exists() {
        return Err(format!("Model file not found: {}", path.display()));
    }
    let path_str = path
        .to_str()
        .ok_or("Model path is not valid UTF-8")?
        .to_string();
    WhisperContext::new_with_params(&path_str, WhisperContextParameters::default())
        .map_err(|e| format!("Load Whisper model: {}", e))
}

/// List .bin files in the models directory (candidates for Whisper GGML models).
pub fn list_models(models_dir: &Path) -> Result<Vec<String>, String> {
    if !models_dir.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in std::fs::read_dir(models_dir).map_err(|e| format!("Read models dir: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path: PathBuf = entry.path();
        if path.extension().map_or(false, |e| e == "bin") && path.is_file() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}
