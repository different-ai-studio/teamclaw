use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::rag::config::RagConfig;

/// Trait for embedding providers (online API or future offline model)
pub trait EmbeddingProvider: Send + Sync {
    fn embed(
        &self,
        texts: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<f32>>>> + Send + '_>>;

    #[allow(dead_code)]
    fn dimensions(&self) -> usize;
}

pub type SharedEmbeddingProvider = Arc<dyn EmbeddingProvider>;

/// Create an embedding provider based on config.
/// Returns Ok even if API key is missing — the error is deferred to when embed() is actually called.
pub fn create_provider(config: &RagConfig) -> Result<SharedEmbeddingProvider> {
    match config.embedding_provider.as_str() {
        "openai" | "compass" => Ok(Arc::new(OnlineProvider {
            api_key: config.embedding_api_key.clone(),
            base_url: config.embedding_base_url.clone(),
            model: config.embedding_model.clone(),
            dimensions: config.embedding_dimensions,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        })),
        other => {
            bail!(
                "Unknown embedding provider: '{}'. Supported: 'openai', 'compass'",
                other
            );
        }
    }
}

/// Online embedding provider using OpenAI-compatible API
struct OnlineProvider {
    api_key: Option<String>,
    base_url: String,
    model: String,
    dimensions: usize,
    client: reqwest::Client,
}

#[derive(Serialize)]
struct EmbeddingRequest {
    model: String,
    input: Vec<String>,
    dimensions: usize,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

impl OnlineProvider {
    fn get_api_key(&self) -> Result<&str> {
        self.api_key.as_deref().filter(|k| !k.is_empty()).context(
            "RAG_EMBEDDING_API_KEY is required when RAG_EMBEDDING_PROVIDER=openai. \
                 Set it in the environment or in opencode.json mcp.rag.environment.",
        )
    }

    async fn embed_batch(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        let api_key = self.get_api_key()?;

        let request = EmbeddingRequest {
            model: self.model.clone(),
            input: texts,
            dimensions: self.dimensions,
        };

        let response = self
            .client
            .post(format!("{}/embeddings", self.base_url))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .context("Failed to send embedding request")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            bail!("Embedding API returned error {}: {}", status, body);
        }

        let response: EmbeddingResponse = response
            .json()
            .await
            .context("Failed to parse embedding response")?;

        let embeddings: Vec<Vec<f32>> = response.data.into_iter().map(|d| d.embedding).collect();

        // Validate dimensions
        for (i, emb) in embeddings.iter().enumerate() {
            if emb.len() != self.dimensions {
                bail!(
                    "Embedding dimension mismatch at index {}: expected {}, got {}",
                    i,
                    self.dimensions,
                    emb.len()
                );
            }
        }

        Ok(embeddings)
    }
}

impl EmbeddingProvider for OnlineProvider {
    fn embed(
        &self,
        texts: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<f32>>>> + Send + '_>> {
        Box::pin(async move {
            if texts.is_empty() {
                return Ok(Vec::new());
            }

            let batch_size = 32;
            let mut all_embeddings = Vec::with_capacity(texts.len());

            for batch_start in (0..texts.len()).step_by(batch_size) {
                let batch_end = (batch_start + batch_size).min(texts.len());
                let batch: Vec<String> = texts[batch_start..batch_end].to_vec();

                let mut retries = 0u32;
                let max_retries = 3u32;

                loop {
                    match self.embed_batch(batch.clone()).await {
                        Ok(embeddings) => {
                            all_embeddings.extend(embeddings);
                            break;
                        }
                        Err(e) => {
                            retries += 1;
                            if retries >= max_retries {
                                return Err(e).context(format!(
                                    "Failed after {} retries for batch starting at index {}",
                                    max_retries, batch_start
                                ));
                            }
                            tracing::warn!(
                                "Embedding batch failed (retry {}/{}): {}",
                                retries,
                                max_retries,
                                e
                            );
                            tokio::time::sleep(std::time::Duration::from_millis(
                                1000 * retries as u64,
                            ))
                            .await;
                        }
                    }
                }
            }

            Ok(all_embeddings)
        })
    }

    fn dimensions(&self) -> usize {
        self.dimensions
    }
}
