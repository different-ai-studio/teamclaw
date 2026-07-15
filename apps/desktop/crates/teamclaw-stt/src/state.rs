use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

pub struct SttState {
    pub listening: AtomicBool,
    /// Set to true from stt_stop_listening so the recording thread exits.
    pub stop: Mutex<Option<std::sync::Arc<AtomicBool>>>,
}

impl Default for SttState {
    fn default() -> Self {
        Self {
            listening: AtomicBool::new(false),
            stop: Mutex::new(None),
        }
    }
}
