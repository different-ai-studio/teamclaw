use std::env;

/// Application configuration loaded from environment variables.
#[derive(Debug, Clone)]
pub struct Config {
    /// API key for the OpenAI-compatible vision endpoint (locate / verify / plan)
    pub vision_api_key: String,
    /// OpenAI-compatible API base URL
    pub vision_base_url: String,
    /// Vision model name
    pub vision_model: String,
}

impl Config {
    /// Build config from environment variables.
    pub fn from_env() -> Self {
        Self {
            vision_api_key: env::var("AUTOUI_VISION_API_KEY").unwrap_or_default(),
            vision_base_url: env::var("AUTOUI_VISION_BASE_URL")
                .unwrap_or_else(|_| "https://dashscope.aliyuncs.com/compatible-mode/v1".into()),
            vision_model: env::var("AUTOUI_VISION_MODEL")
                .unwrap_or_else(|_| "qwen3-vl-flash".into()),
        }
    }

    /// Returns true when a vision API key has been configured.
    pub fn has_vision(&self) -> bool {
        !self.vision_api_key.is_empty()
    }
}
