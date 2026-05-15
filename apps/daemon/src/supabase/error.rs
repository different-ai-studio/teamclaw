use thiserror::Error;

#[derive(Debug, Error)]
pub enum SupabaseError {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("auth error: {0}")]
    Auth(String),

    #[error("invite invalid or expired")]
    InviteInvalid,

    #[error("invite already claimed")]
    InviteClaimed,

    #[error("rpc error: {code:?}: {message}")]
    Rpc {
        code: Option<String>,
        message: String,
    },

    #[error("invalid jwt: {0}")]
    InvalidJwt(String),

    #[error("config error: {0}")]
    Config(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type SupabaseResult<T> = Result<T, SupabaseError>;
