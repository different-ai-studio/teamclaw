use std::env;

/// Application configuration loaded from environment variables.
#[derive(Debug, Clone)]
pub struct Config {
    /// Qwen API key for vision locate / verify
    pub qwen_api_key: String,
    /// Qwen-compatible API base URL
    pub qwen_base_url: String,
    /// Vision model name
    pub qwen_model: String,
}

impl Config {
    /// Build config from environment variables.
    pub fn from_env() -> Self {
        Self {
            qwen_api_key: env::var("QWEN_API_KEY").unwrap_or_default(),
            qwen_base_url: env::var("QWEN_BASE_URL")
                .unwrap_or_else(|_| "https://dashscope.aliyuncs.com/compatible-mode/v1".into()),
            qwen_model: env::var("QWEN_MODEL").unwrap_or_else(|_| "qwen3-vl-flash".into()),
        }
    }

    /// Returns true when a Qwen API key has been configured.
    pub fn has_vision(&self) -> bool {
        !self.qwen_api_key.is_empty()
    }
}
