use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Receiver;
use std::sync::Arc;

use crate::audio;

const WHISPER_SAMPLE_RATE: u32 = 16000;

const STREAM_STEP_MS: u32 = 500;
const STREAM_LENGTH_MS: u32 = 5000;
const STREAM_KEEP_MS: u32 = 200;
const MIN_WHISPER_SAMPLES: usize = 16000;

/// Generic event emitter callback.
/// First argument is event name (e.g. "stt:transcript", "stt:error"),
/// second argument is the JSON payload.
pub type EventEmitter = Box<dyn Fn(&str, serde_json::Value) + Send>;

/// Resample mono f32 to 16kHz (linear interpolation).
#[allow(dead_code)]
fn resample_to_16k(samples: &[f32], from_rate: u32) -> Vec<f32> {
    if from_rate == WHISPER_SAMPLE_RATE || samples.is_empty() {
        return samples.to_vec();
    }
    let out_len = (samples.len() as u64 * WHISPER_SAMPLE_RATE as u64 / from_rate as u64) as usize;
    if out_len == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_idx = (i as f64 * (samples.len() - 1) as f64) / (out_len - 1).max(1) as f64;
        let lo = src_idx.floor() as usize;
        let hi = (lo + 1).min(samples.len() - 1);
        let t = src_idx - lo as f64;
        let v = samples[lo] as f64 + t * (samples[hi] as f64 - samples[lo] as f64);
        out.push(v as f32);
    }
    out
}

/// Streaming pipeline: receive chunks from `rx`, accumulate into windows of `length_ms`,
/// transcribe each full window, then on channel close transcribe remainder and emit one final transcript.
pub fn run_pipeline_streaming_from_rx(
    on_event: &EventEmitter,
    models_dir: &std::path::Path,
    rx: Receiver<Vec<f32>>,
    language: Option<&str>,
) {
    let n_samples_window = (WHISPER_SAMPLE_RATE as u64 * STREAM_LENGTH_MS as u64 / 1000) as usize;
    let n_samples_keep = (WHISPER_SAMPLE_RATE as u64 * STREAM_KEEP_MS as u64 / 1000) as usize;
    let mut segment_window: Vec<f32> = Vec::with_capacity(n_samples_window + 8000);
    let mut segments: Vec<String> = Vec::new();
    while let Ok(chunk) = rx.recv() {
        segment_window.extend(chunk);
        while segment_window.len() >= n_samples_window {
            let window: Vec<f32> = segment_window.drain(..n_samples_window).collect();
            let text = transcribe_audio(on_event, models_dir, &window, WHISPER_SAMPLE_RATE, language);
            if !text.is_empty() {
                segments.push(text);
            }
            let to_drop = segment_window.len().saturating_sub(n_samples_keep);
            if to_drop > 0 {
                segment_window.drain(..to_drop);
            }
        }
    }
    if !segment_window.is_empty() {
        let pad = if segment_window.len() < MIN_WHISPER_SAMPLES {
            MIN_WHISPER_SAMPLES.saturating_sub(segment_window.len())
        } else {
            0
        };
        for _ in 0..pad {
            segment_window.push(0.0);
        }
        let text = transcribe_audio(on_event, models_dir, &segment_window, WHISPER_SAMPLE_RATE, language);
        if !text.is_empty() {
            segments.push(text);
        }
    }
    let full = segments.join(" ").trim().to_string();
    on_event(
        "stt:transcript",
        serde_json::json!({ "partial": false, "text": full }),
    );
}

/// Run streaming pipeline: chunked capture, sliding-window transcription, single emit on stop.
pub fn run_pipeline_streaming(
    on_event: EventEmitter,
    models_dir: std::path::PathBuf,
    stop: Arc<AtomicBool>,
    language: Option<String>,
) {
    let rx = match audio::stream_chunks_until_stopped(stop, STREAM_STEP_MS) {
        Ok(r) => r,
        Err(e) => {
            on_event("stt:error", serde_json::json!({ "message": e }));
            return;
        }
    };
    run_pipeline_streaming_from_rx(&on_event, &models_dir, rx, language.as_deref());
}

/// Record until stop is set, then transcribe (when Whisper is built) and emit final transcript.
/// `language` is the Whisper language code (e.g. "en", "zh"); None = auto-detect.
#[allow(dead_code)]
pub fn run_pipeline(
    on_event: EventEmitter,
    models_dir: std::path::PathBuf,
    stop: Arc<AtomicBool>,
    language: Option<String>,
) {
    let recorded = match audio::record_until_stopped(stop) {
        Ok(r) => r,
        Err(e) => {
            on_event("stt:error", serde_json::json!({ "message": e }));
            return;
        }
    };

    let text = transcribe_audio(
        &on_event,
        &models_dir,
        &recorded.samples,
        recorded.sample_rate,
        language.as_deref(),
    );
    on_event(
        "stt:transcript",
        serde_json::json!({ "partial": false, "text": text }),
    );
}

#[cfg(feature = "whisper")]
fn transcribe_audio(
    on_event: &EventEmitter,
    models_dir: &std::path::Path,
    samples: &[f32],
    sample_rate: u32,
    language: Option<&str>,
) -> String {
    use crate::{list_models, load_model, DEFAULT_MODEL_NAME};
    use whisper_rs::{FullParams, SamplingStrategy};

    let model_names: Vec<String> = match list_models(models_dir) {
        Ok(n) => n,
        Err(e) => {
            on_event("stt:error", serde_json::json!({ "message": e }));
            return String::new();
        }
    };
    let model_name = model_names
        .iter()
        .find(|n| *n == DEFAULT_MODEL_NAME)
        .map(String::as_str)
        .or_else(|| model_names.first().map(String::as_str))
        .unwrap_or_default();
    if model_name.is_empty() {
        on_event(
            "stt:error",
            serde_json::json!({ "message": "No Whisper model in stt_models dir" }),
        );
        return String::new();
    }
    let ctx = match load_model(models_dir, model_name) {
        Ok(c) => c,
        Err(e) => {
            on_event("stt:error", serde_json::json!({ "message": e }));
            return String::new();
        }
    };
    let pcm_16k = resample_to_16k(samples, sample_rate);
    if pcm_16k.is_empty() {
        return String::new();
    }
    let mut state = match ctx.create_state() {
        Ok(s) => s,
        Err(e) => {
            on_event(
                "stt:error",
                serde_json::json!({ "message": format!("Whisper state: {}", e) }),
            );
            return String::new();
        }
    };
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    if let Some(lang) = language {
        params.set_language(Some(lang));
    } else {
        params.set_detect_language(true);
    }
    if let Err(e) = state.full(params, &pcm_16k) {
        on_event(
            "stt:error",
            serde_json::json!({ "message": format!("Whisper transcribe: {}", e) }),
        );
        return String::new();
    }
    let mut text = String::new();
    for segment in state.as_iter() {
        if let Ok(s) = segment.to_str() {
            text.push_str(s);
        }
    }
    text.trim().to_string()
}

#[cfg(not(feature = "whisper"))]
fn transcribe_audio(
    _on_event: &EventEmitter,
    _models_dir: &std::path::Path,
    _samples: &[f32],
    _sample_rate: u32,
    _language: Option<&str>,
) -> String {
    String::new()
}
