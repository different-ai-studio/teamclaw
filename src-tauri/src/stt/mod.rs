mod audio;
mod model;
mod paths;
mod pipeline;
mod state;

#[allow(unused_imports)]
pub use audio::{record_until_stopped, stream_chunks_until_stopped, RecordedAudio};
#[allow(unused_imports)]
pub use model::{list_models, DEFAULT_MODEL_NAME};
#[cfg(feature = "stt-whisper")]
pub use model::load_model;
pub use paths::stt_models_dir;
#[allow(unused_imports)]
pub use pipeline::{run_pipeline, run_pipeline_streaming};
pub use state::SttState;
