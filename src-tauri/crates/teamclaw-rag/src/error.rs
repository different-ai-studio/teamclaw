use thiserror::Error;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum RagError {
    #[error("Database error: {0}")]
    Database(String),

    #[error("Embedding error: {0}")]
    Embedding(String),

    #[error("Search error: {0}")]
    Search(String),

    #[error("Index error: {0}")]
    Index(String),

    #[error("Config error: {0}")]
    Config(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Other error: {0}")]
    Other(String),
}

impl From<anyhow::Error> for RagError {
    fn from(err: anyhow::Error) -> Self {
        RagError::Other(err.to_string())
    }
}

#[allow(dead_code)]
pub type Result<T> = std::result::Result<T, RagError>;
