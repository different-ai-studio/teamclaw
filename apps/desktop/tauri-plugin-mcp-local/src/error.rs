use serde::{Deserialize, Serialize};
use thiserror::Error as ThisError;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(ThisError, Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "message")]
pub enum Error {
    #[error("Window not found: {0}")]
    WindowNotFound(String),

    #[error("Window operation failed: {0}")]
    WindowOperationFailed(String),

    #[error("Plugin initialization error: {0}")]
    PluginInit(String),

    #[error("IO error: {0}")]
    Io(String),

    /// IO error that preserves the underlying `std::io::Error` so callers
    /// can match on `std::io::ErrorKind` (e.g. to detect disconnects).
    /// Not serializable; skipped by serde. Use `Io(String)` for errors that
    /// must cross a serialization boundary.
    #[error("IO error: {0}")]
    #[serde(skip)]
    IoSource(#[from] std::io::Error),

    #[error("{0}")]
    Anyhow(String),

    #[error("Tauri error: {0}")]
    TauriError(String),
}

impl From<anyhow::Error> for Error {
    fn from(error: anyhow::Error) -> Self {
        Self::Anyhow(error.to_string())
    }
}

impl From<tauri::Error> for Error {
    fn from(error: tauri::Error) -> Self {
        Self::TauriError(error.to_string())
    }
}
