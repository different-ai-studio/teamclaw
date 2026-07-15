use thiserror::Error;

#[derive(Debug, Error)]
pub enum BackendError {
    #[error("auth error: {0}")]
    Auth(String),

    #[error("validation error: {0}")]
    #[allow(dead_code)]
    Validation(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("{provider} provider error: {code:?}: {message}")]
    Provider {
        provider: &'static str,
        code: Option<String>,
        message: String,
    },

    #[error("config error: {0}")]
    #[allow(dead_code)]
    Config(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type BackendResult<T> = Result<T, BackendError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_auth() {
        let e = BackendError::Auth("token expired".into());
        assert_eq!(e.to_string(), "auth error: token expired");
    }

    #[test]
    fn display_not_found() {
        let e = BackendError::NotFound("session missing".into());
        assert_eq!(e.to_string(), "not found: session missing");
    }

    #[test]
    fn display_provider_with_code() {
        let e = BackendError::Provider {
            provider: "cloud_api",
            code: Some("ERR_DB".into()),
            message: "db error".into(),
        };
        let s = e.to_string();
        assert!(s.contains("cloud_api"));
        assert!(s.contains("ERR_DB"));
        assert!(s.contains("db error"));
    }

    #[test]
    fn display_provider_no_code() {
        let e = BackendError::Provider {
            provider: "cloud_api",
            code: None,
            message: "unknown".into(),
        };
        let s = e.to_string();
        assert!(s.contains("None"));
    }

    #[test]
    fn from_io_error() {
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let e = BackendError::from(io);
        assert!(e.to_string().contains("access denied"));
        assert!(matches!(e, BackendError::Io(_)));
    }

    #[test]
    fn from_serde_error() {
        let err: serde_json::Error = serde_json::from_str::<serde_json::Value>("{bad}").unwrap_err();
        let e = BackendError::from(err);
        assert!(matches!(e, BackendError::Serde(_)));
    }
}
