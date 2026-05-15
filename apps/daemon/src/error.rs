use thiserror::Error;

#[derive(Error, Debug)]
pub enum AmuxError {
    #[error("config error: {0}")]
    Config(String),
    #[error("mqtt error: {0}")]
    Mqtt(#[from] rumqttc::ClientError),
    #[error("proto encode error: {0}")]
    ProtoEncode(#[from] prost::EncodeError),
    #[error("proto decode error: {0}")]
    ProtoDecode(#[from] prost::DecodeError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("agent error: {0}")]
    Agent(String),
    #[error("auth error: {0}")]
    Auth(String),
    #[error("ipc error: {0}")]
    Ipc(String),
}

pub type Result<T> = std::result::Result<T, AmuxError>;
