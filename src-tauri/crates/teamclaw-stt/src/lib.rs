mod audio;
mod model;
mod pipeline;
mod state;

#[allow(unused_imports)]
pub use audio::{record_until_stopped, stream_chunks_until_stopped, RecordedAudio};
#[cfg(feature = "whisper")]
pub use model::load_model;
#[allow(unused_imports)]
pub use model::{list_models, DEFAULT_MODEL_NAME};
pub use pipeline::{run_pipeline, run_pipeline_streaming, EventEmitter};
pub use state::SttState;
