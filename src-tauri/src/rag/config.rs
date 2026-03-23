use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagConfig {
    pub embedding_provider: String,
    pub embedding_model: String,
    pub embedding_dimensions: usize,
    pub embedding_api_key: Option<String>,
    pub embedding_base_url: String,
    pub chunk_size: usize,
    pub chunk_overlap: usize,
    pub auto_index: bool,

    // Knowledge directories
    #[serde(default = "default_knowledge_dirs")]
    pub knowledge_dirs: Vec<String>,

    // Hybrid search
    pub hybrid_weight: f64,

    // Reranking
    pub rerank_enabled: bool,
    pub rerank_provider: String,
    pub rerank_model: String,
    pub rerank_api_key: Option<String>,
    #[serde(default = "default_rerank_base_url")]
    pub rerank_base_url: String,
    pub rerank_top_k: usize,

    // File watcher
    pub file_watcher_enabled: bool,

    // RAG V2: Auto-inject (Pre-inference)
    pub auto_inject_enabled: bool,
    pub auto_inject_threshold: f64,
    pub auto_inject_top_k: usize,
    pub auto_inject_max_tokens: usize,

    // Long-term Memory
    #[serde(default = "default_true")]
    pub memory_enabled: bool,
    #[serde(default = "default_true")]
    pub memory_auto_extract: bool,
}

fn default_true() -> bool {
    true
}

fn default_knowledge_dirs() -> Vec<String> {
    vec!["knowledge".to_string()]
}

fn default_rerank_base_url() -> String {
    "https://compass.llm.shopee.io/compass-api/v1".to_string()
}

impl Default for RagConfig {
    fn default() -> Self {
        Self {
            embedding_provider: "compass".to_string(),
            embedding_model: "compass-embedding-v4".to_string(),
            embedding_dimensions: 2560,
            embedding_api_key: None,
            embedding_base_url: "https://compass.llm.shopee.io/compass-api/v1".to_string(),
            chunk_size: 800,
            chunk_overlap: 100,
            auto_index: true,
            knowledge_dirs: vec!["knowledge".to_string()],
            hybrid_weight: 0.7,
            rerank_enabled: false,
            rerank_provider: "compass".to_string(),
            rerank_model: String::new(),
            rerank_api_key: None,
            rerank_base_url: default_rerank_base_url(),
            rerank_top_k: 20,
            file_watcher_enabled: true,
            auto_inject_enabled: true,
            auto_inject_threshold: 0.7,
            auto_inject_top_k: 3,
            auto_inject_max_tokens: 2000,
            memory_enabled: true,
            memory_auto_extract: true,
        }
    }
}

impl RagConfig {
    /// Load config from workspace directory
    /// Priority: .teamclaw/rag-config.json > defaults
    /// If no config file exists, creates one with default values
    pub async fn load_from_workspace(workspace_path: &Path) -> anyhow::Result<Self> {
        let rag_config_path = workspace_path.join(".teamclaw/rag-config.json");
        if rag_config_path.exists() {
            let content = tokio::fs::read_to_string(&rag_config_path).await?;
            let config: RagConfig = serde_json::from_str(&content)?;
            return Ok(config);
        }

        let config = Self::default();

        if let Err(e) = config.save_to_workspace(workspace_path).await {
            tracing::warn!(
                "[RAG] Failed to auto-create rag-config.json: {}. Using in-memory defaults.",
                e
            );
        } else {
            tracing::info!(
                "[RAG] Auto-created rag-config.json with default values at {}",
                rag_config_path.display()
            );
        }

        Ok(config)
    }

    /// Save config to .teamclaw/rag-config.json
    pub async fn save_to_workspace(&self, workspace_path: &Path) -> anyhow::Result<()> {
        let teamclaw_dir = workspace_path.join(".teamclaw");
        tokio::fs::create_dir_all(&teamclaw_dir).await?;

        let config_path = teamclaw_dir.join("rag-config.json");
        let content = serde_json::to_string_pretty(self)?;
        tokio::fs::write(&config_path, content).await?;

        Ok(())
    }

    /// Get database path for workspace
    pub fn db_path(&self, workspace_path: &Path) -> PathBuf {
        workspace_path.join(".teamclaw/knowledge.db")
    }

    /// Get BM25 index path for workspace
    pub fn bm25_index_path(&self, workspace_path: &Path) -> PathBuf {
        workspace_path.join(".teamclaw/bm25_index")
    }

    /// Get knowledge directory paths
    pub fn knowledge_dirs(&self, workspace_path: &Path) -> Vec<PathBuf> {
        self.knowledge_dirs
            .iter()
            .map(|dir| workspace_path.join(dir))
            .collect()
    }

    /// Get knowledge directory path (deprecated, use knowledge_dirs instead)
    /// Returns first directory for backward compatibility
    #[allow(dead_code)]
    pub fn knowledge_dir(&self, workspace_path: &Path) -> PathBuf {
        self.knowledge_dirs(workspace_path)
            .into_iter()
            .next()
            .unwrap_or_else(|| workspace_path.join("knowledge"))
    }
}
