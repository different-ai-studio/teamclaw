use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

const TARGET_SAMPLE_RATE: u32 = 16000;

/// Recorded audio: mono f32 samples and the device sample rate (for resampling to 16kHz if needed).
#[allow(dead_code)]
pub struct RecordedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// Record from default input device into a buffer until `stop` is set to true.
#[allow(dead_code)]
pub fn record_until_stopped(stop: Arc<AtomicBool>) -> Result<RecordedAudio, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No default input device")?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("Default input config: {}", e))?;

    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

    let config_clone = config.clone();
    let buffer_clone = Arc::clone(&buffer);

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let buffer_in = buffer_clone;
            device.build_input_stream(
                &config_clone.into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    buffer_in.lock().unwrap().extend_from_slice(data);
                },
                |err| {
                    eprintln!("[STT audio] stream error: {}", err);
                },
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let buffer_in = buffer_clone;
            device.build_input_stream(
                &config_clone.into(),
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let f32_samples: Vec<f32> =
                        data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                    buffer_in.lock().unwrap().extend(f32_samples);
                },
                |err| {
                    eprintln!("[STT audio] stream error: {}", err);
                },
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let buffer_in = buffer_clone;
            device.build_input_stream(
                &config_clone.into(),
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let f32_samples: Vec<f32> = data
                        .iter()
                        .map(|&s| (s as f32 / u16::MAX as f32) * 2.0 - 1.0)
                        .collect();
                    buffer_in.lock().unwrap().extend(f32_samples);
                },
                |err| {
                    eprintln!("[STT audio] stream error: {}", err);
                },
                None,
            )
        }
        _ => return Err("Unsupported sample format".to_string()),
    }
    .map_err(|e| format!("Build input stream: {}", e))?;

    stream.play().map_err(|e| format!("Stream play: {}", e))?;

    while !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(50));
    }

    drop(stream);

    let samples = buffer.lock().unwrap().clone();
    let sample_rate = config.sample_rate();
    Ok(RecordedAudio {
        samples,
        sample_rate,
    })
}

fn resample_to_16k(samples: &[f32], from_rate: u32) -> Vec<f32> {
    if from_rate == TARGET_SAMPLE_RATE || samples.is_empty() {
        return samples.to_vec();
    }
    let out_len = (samples.len() as u64 * TARGET_SAMPLE_RATE as u64 / from_rate as u64) as usize;
    if out_len == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_idx = (i as f64 * (samples.len() - 1) as f64) / (out_len - 1).max(1) as f64;
        let lo = src_idx.floor() as usize;
        let hi = (lo + 1).min(samples.len().saturating_sub(1));
        let t = src_idx - lo as f64;
        let v = samples[lo] as f64 + t * (samples[hi] as f64 - samples[lo] as f64);
        out.push(v as f32);
    }
    out
}

/// Start chunked capture: returns a receiver of 16 kHz mono f32 chunks (step_ms per chunk).
/// When `stop` is set, the sender is dropped and the receiver iteration ends.
#[allow(dead_code)]
pub fn stream_chunks_until_stopped(
    stop: Arc<AtomicBool>,
    step_ms: u32,
) -> Result<Receiver<Vec<f32>>, String> {
    let (tx, rx) = mpsc::channel();
    if stop.load(Ordering::SeqCst) {
        drop(tx);
        return Ok(rx);
    }
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No default input device")?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("Default input config: {}", e))?;
    let sample_rate = config.sample_rate();
    let samples_per_step = (sample_rate as u64 * step_ms as u64 / 1000) as usize;
    if samples_per_step == 0 {
        drop(tx);
        return Ok(rx);
    }
    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let config_clone = config.clone();
    let buffer_clone = Arc::clone(&buffer);
    thread::spawn(move || {
        let stream = match config_clone.sample_format() {
            cpal::SampleFormat::F32 => {
                let buffer_in = buffer_clone;
                device.build_input_stream(
                    &config_clone.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        buffer_in.lock().unwrap().extend_from_slice(data);
                    },
                    |err| {
                        eprintln!("[STT audio] stream error: {}", err);
                    },
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let buffer_in = buffer_clone;
                device.build_input_stream(
                    &config_clone.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let f32_samples: Vec<f32> =
                            data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                        buffer_in.lock().unwrap().extend(f32_samples);
                    },
                    |err| {
                        eprintln!("[STT audio] stream error: {}", err);
                    },
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let buffer_in = buffer_clone;
                device.build_input_stream(
                    &config_clone.into(),
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let f32_samples: Vec<f32> = data
                            .iter()
                            .map(|&s| (s as f32 / u16::MAX as f32) * 2.0 - 1.0)
                            .collect();
                        buffer_in.lock().unwrap().extend(f32_samples);
                    },
                    |err| {
                        eprintln!("[STT audio] stream error: {}", err);
                    },
                    None,
                )
            }
            _ => {
                drop(tx);
                return;
            }
        };
        let stream = match stream {
            Ok(s) => s,
            Err(_) => {
                drop(tx);
                return;
            }
        };
        if stream.play().is_err() {
            drop(tx);
            return;
        }
        while !stop.load(Ordering::SeqCst) {
            let chunk = {
                let mut buf = buffer.lock().unwrap();
                if buf.len() >= samples_per_step {
                    let take: Vec<f32> = buf.drain(..samples_per_step).collect();
                    take
                } else {
                    Vec::new()
                }
            };
            if !chunk.is_empty() {
                let out = resample_to_16k(&chunk, sample_rate);
                if tx.send(out).is_err() {
                    break;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        drop(stream);
        drop(tx);
    });
    Ok(rx)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    use super::stream_chunks_until_stopped;

    #[test]
    fn stream_chunks_until_stopped_returns_receiver() {
        let stop = Arc::new(AtomicBool::new(true));
        let rx = stream_chunks_until_stopped(stop, 500).expect("should not fail at init");
        assert!(
            rx.recv().is_err(),
            "when stop is already set, channel should be closed"
        );
    }

    #[test]
    fn stream_chunks_until_stopped_stop_ends_receiver() {
        let stop = Arc::new(AtomicBool::new(false));
        let rx = stream_chunks_until_stopped(stop.clone(), 500).expect("should not fail at init");
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let mut count = 0u32;
        while rx.recv().is_ok() {
            count += 1;
        }
        // Receiver iteration ends after stop is set (channel closed)
    }
}
