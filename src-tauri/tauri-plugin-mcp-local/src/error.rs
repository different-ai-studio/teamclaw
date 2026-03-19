use serde::{Deserialize, Serialize};
use thiserror::Error as ThisError;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(ThisError, Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "data")]
pub enum Error {
    /// Window not found with specific label
    #[error("Window not found: {label}")]
    WindowNotFound { label: String },

    /// Window operation failed with context about what was attempted
    #[error("Window operation failed: {operation} - {reason}")]
    WindowOperationFailed {
        operation: String,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<String>,
    },

    /// Invalid parameter with details about what was expected vs received
    #[error("Invalid parameter '{param}': expected {expected}, got {received}")]
    InvalidParameter {
        param: String,
        expected: String,
        received: String,
    },

    /// Operation timed out with duration and operation name
    #[error("Operation timed out: {operation} (exceeded {duration_ms}ms)")]
    TimeoutError {
        operation: String,
        duration_ms: u64,
    },

    /// Serialization/deserialization error
    #[error("Serialization error: {message}")]
    SerializationError { message: String },

    /// Communication error between components with optional context
    #[error("Communication error: {message}")]
    CommunicationError {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<String>,
    },

    /// Plugin initialization error
    #[error("Plugin initialization error: {message}")]
    PluginInit { message: String },

    /// IO error
    #[error("IO error: {message}")]
    Io { message: String },

    /// Generic error with message (fallback)
    #[error("{message}")]
    Anyhow { message: String },

    /// Tauri-specific error
    #[error("Tauri error: {message}")]
    TauriError { message: String },
}

impl Error {
    /// Create a WindowNotFound error with label
    pub fn window_not_found(label: impl Into<String>) -> Self {
        Self::WindowNotFound {
            label: label.into(),
        }
    }

    /// Create a WindowOperationFailed error with operation and reason
    pub fn window_operation_failed(
        operation: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self::WindowOperationFailed {
            operation: operation.into(),
            reason: reason.into(),
            context: None,
        }
    }

    /// Create a WindowOperationFailed error with operation, reason, and context
    pub fn window_operation_failed_with_context(
        operation: impl Into<String>,
        reason: impl Into<String>,
        context: impl Into<String>,
    ) -> Self {
        Self::WindowOperationFailed {
            operation: operation.into(),
            reason: reason.into(),
            context: Some(context.into()),
        }
    }

    /// Create an InvalidParameter error
    pub fn invalid_parameter(
        param: impl Into<String>,
        expected: impl Into<String>,
        received: impl Into<String>,
    ) -> Self {
        Self::InvalidParameter {
            param: param.into(),
            expected: expected.into(),
            received: received.into(),
        }
    }

    /// Create a TimeoutError
    pub fn timeout_error(operation: impl Into<String>, duration_ms: u64) -> Self {
        Self::TimeoutError {
            operation: operation.into(),
            duration_ms,
        }
    }

    /// Create a SerializationError
    pub fn serialization_error(message: impl Into<String>) -> Self {
        Self::SerializationError {
            message: message.into(),
        }
    }

    /// Create a CommunicationError
    pub fn communication_error(message: impl Into<String>) -> Self {
        Self::CommunicationError {
            message: message.into(),
            context: None,
        }
    }

    /// Create a CommunicationError with context
    pub fn communication_error_with_context(
        message: impl Into<String>,
        context: impl Into<String>,
    ) -> Self {
        Self::CommunicationError {
            message: message.into(),
            context: Some(context.into()),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io {
            message: error.to_string(),
        }
    }
}

impl From<anyhow::Error> for Error {
    fn from(error: anyhow::Error) -> Self {
        Self::Anyhow {
            message: error.to_string(),
        }
    }
}

impl From<tauri::Error> for Error {
    fn from(error: tauri::Error) -> Self {
        Self::TauriError {
            message: error.to_string(),
        }
    }
}
