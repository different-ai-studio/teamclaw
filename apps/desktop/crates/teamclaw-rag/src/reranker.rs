use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;

pub type RerankScores = Vec<(usize, f64)>;
pub type RerankFuture<'a> = Pin<Box<dyn Future<Output = Result<RerankScores>> + Send + 'a>>;

/// Trait for reranking providers
pub trait Reranker: Send + Sync {
    fn rerank<'a>(&'a self, query: &'a str, documents: Vec<&'a str>) -> RerankFuture<'a>;
}

// ---------------------------------------------------------------------------
// Jina Reranker
// ---------------------------------------------------------------------------

pub struct JinaReranker {
    client: reqwest::Client,
    api_key: Option<String>,
    model: String,
    base_url: String,
}

#[derive(Serialize)]
struct JinaRerankRequest {
    model: String,
    query: String,
    documents: Vec<String>,
    top_n: Option<usize>,
}

#[derive(Deserialize)]
struct JinaRerankResponse {
    results: Vec<JinaRerankResult>,
}

#[derive(Deserialize)]
struct JinaRerankResult {
    index: usize,
    relevance_score: f64,
}

impl JinaReranker {
    pub fn new(api_key: Option<String>, model: String) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            api_key,
            model,
            base_url: "https://api.jina.ai/v1".to_string(),
        }
    }

    fn get_api_key(&self) -> Result<&str> {
        self.api_key.as_deref().filter(|k| !k.is_empty()).context(
            "RAG_RERANK_API_KEY is required when RAG_RERANK_ENABLED=true. \
                 Set it in the environment or in opencode.json mcp.rag.environment.",
        )
    }

    async fn rerank_internal(
        &self,
        query: &str,
        documents: Vec<String>,
        top_n: Option<usize>,
    ) -> Result<Vec<JinaRerankResult>> {
        let api_key = self.get_api_key()?;

        let request = JinaRerankRequest {
            model: self.model.clone(),
            query: query.to_string(),
            documents,
            top_n,
        };

        let response = self
            .client
            .post(format!("{}/rerank", self.base_url))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .context("Failed to send rerank request")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Rerank API returned error {}: {}", status, body);
        }

        let response: JinaRerankResponse = response
            .json()
            .await
            .context("Failed to parse rerank response")?;

        Ok(response.results)
    }
}

impl Reranker for JinaReranker {
    fn rerank<'a>(
        &'a self,
        query: &'a str,
        documents: Vec<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<(usize, f64)>>> + Send + 'a>> {
        Box::pin(async move {
            if documents.is_empty() {
                return Ok(Vec::new());
            }

            let docs: Vec<String> = documents.iter().map(|d| d.to_string()).collect();

            let results = self
                .rerank_internal(query, docs, None)
                .await
                .context("Failed to rerank documents")?;

            let scored_results: Vec<(usize, f64)> = results
                .into_iter()
                .map(|r| (r.index, r.relevance_score))
                .collect();

            Ok(scored_results)
        })
    }
}

// ---------------------------------------------------------------------------
// Compass Reranker
// Response `results` is a positional array of scores matching the input order.
// ---------------------------------------------------------------------------

pub struct CompassReranker {
    client: reqwest::Client,
    api_key: Option<String>,
    base_url: String,
}

#[derive(Serialize)]
struct CompassRerankRequest {
    id: String,
    query: String,
    documents: Vec<String>,
}

#[derive(Deserialize)]
struct CompassRerankResponse {
    #[allow(dead_code)]
    code: i32,
    results: Vec<f64>,
}

impl CompassReranker {
    pub fn new(api_key: Option<String>, base_url: String) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            api_key,
            base_url,
        }
    }

    fn get_api_key(&self) -> Result<&str> {
        self.api_key
            .as_deref()
            .filter(|k| !k.is_empty())
            .with_context(|| {
                "RAG_RERANK_API_KEY is required when RAG_RERANK_ENABLED=true (provider=compass). \
                 Set it in .teamclaw/rag-config.json or opencode.json mcp.rag.environment."
                    .to_string()
            })
    }

    async fn rerank_internal(
        &self,
        query: &str,
        documents: Vec<String>,
    ) -> Result<Vec<(usize, f64)>> {
        let api_key = self.get_api_key()?;

        let request = CompassRerankRequest {
            id: uuid::Uuid::new_v4().to_string(),
            query: query.to_string(),
            documents,
        };

        let response = self
            .client
            .post(format!("{}/rerank", self.base_url.trim_end_matches('/')))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .context("Failed to send Compass rerank request")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Compass Rerank API returned error {}: {}", status, body);
        }

        let resp: CompassRerankResponse = response
            .json()
            .await
            .context("Failed to parse Compass rerank response")?;

        if resp.code != 0 {
            anyhow::bail!("Compass Rerank API returned non-zero code: {}", resp.code);
        }

        Ok(resp
            .results
            .into_iter()
            .enumerate()
            .collect())
    }
}

impl Reranker for CompassReranker {
    fn rerank<'a>(
        &'a self,
        query: &'a str,
        documents: Vec<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<(usize, f64)>>> + Send + 'a>> {
        Box::pin(async move {
            if documents.is_empty() {
                return Ok(Vec::new());
            }

            let docs: Vec<String> = documents.iter().map(|d| d.to_string()).collect();

            self.rerank_internal(query, docs)
                .await
                .context("Failed to rerank documents via Compass")
        })
    }
}

// ---------------------------------------------------------------------------
// LangSearch Reranker  (https://api.langsearch.com/v1/rerank)
// Response format similar to Jina: results contain { index, relevance_score }.
// ---------------------------------------------------------------------------

pub struct LangSearchReranker {
    client: reqwest::Client,
    api_key: Option<String>,
    model: String,
    base_url: String,
}

#[derive(Serialize)]
struct LangSearchRerankRequest {
    model: String,
    query: String,
    documents: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_n: Option<usize>,
    return_documents: bool,
}

#[derive(Deserialize)]
struct LangSearchRerankResponse {
    #[allow(dead_code)]
    code: i32,
    results: Vec<LangSearchRerankResult>,
}

#[derive(Deserialize)]
struct LangSearchRerankResult {
    index: usize,
    relevance_score: f64,
}

impl LangSearchReranker {
    pub fn new(api_key: Option<String>, model: String, base_url: Option<String>) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            api_key,
            model: if model.is_empty() {
                "langsearch-reranker-v1".to_string()
            } else {
                model
            },
            base_url: base_url.unwrap_or_else(|| "https://api.langsearch.com/v1".to_string()),
        }
    }

    fn get_api_key(&self) -> Result<&str> {
        self.api_key
            .as_deref()
            .filter(|k| !k.is_empty())
            .with_context(|| {
                "RAG_RERANK_API_KEY is required when RAG_RERANK_ENABLED=true (provider=langsearch). \
                 Set it in .teamclaw/rag-config.json or opencode.json mcp.rag.environment."
                    .to_string()
            })
    }

    async fn rerank_internal(
        &self,
        query: &str,
        documents: Vec<String>,
        top_n: Option<usize>,
    ) -> Result<Vec<LangSearchRerankResult>> {
        let api_key = self.get_api_key()?;

        let request = LangSearchRerankRequest {
            model: self.model.clone(),
            query: query.to_string(),
            documents,
            top_n,
            return_documents: false,
        };

        let response = self
            .client
            .post(format!("{}/rerank", self.base_url.trim_end_matches('/')))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .context("Failed to send LangSearch rerank request")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("LangSearch Rerank API returned error {}: {}", status, body);
        }

        let resp: LangSearchRerankResponse = response
            .json()
            .await
            .context("Failed to parse LangSearch rerank response")?;

        Ok(resp.results)
    }
}

impl Reranker for LangSearchReranker {
    fn rerank<'a>(
        &'a self,
        query: &'a str,
        documents: Vec<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<(usize, f64)>>> + Send + 'a>> {
        Box::pin(async move {
            if documents.is_empty() {
                return Ok(Vec::new());
            }

            let docs: Vec<String> = documents.iter().map(|d| d.to_string()).collect();

            let results = self
                .rerank_internal(query, docs, None)
                .await
                .context("Failed to rerank documents via LangSearch")?;

            Ok(results
                .into_iter()
                .map(|r| (r.index, r.relevance_score))
                .collect())
        })
    }
}

/// Create a reranker based on provider name.
/// `base_url` is used by providers that need a configurable endpoint (e.g. compass, langsearch).
pub fn create_reranker(
    provider: &str,
    api_key: Option<String>,
    model: String,
    base_url: Option<String>,
) -> Result<Box<dyn Reranker>> {
    match provider.to_lowercase().as_str() {
        "jina" => Ok(Box::new(JinaReranker::new(api_key, model))),
        "compass" => {
            let url = base_url.unwrap_or_default();
            Ok(Box::new(CompassReranker::new(api_key, url)))
        }
        "langsearch" => Ok(Box::new(LangSearchReranker::new(api_key, model, base_url))),
        other => {
            anyhow::bail!(
                "Unknown reranker provider: '{}'. Supported: 'jina', 'compass', 'langsearch'",
                other
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jina_reranker_creation() {
        let reranker = JinaReranker::new(
            Some("test-key".to_string()),
            "jina-reranker-v2-base-multilingual".to_string(),
        );
        assert_eq!(reranker.model, "jina-reranker-v2-base-multilingual");
    }

    #[test]
    fn test_compass_reranker_creation() {
        let reranker = CompassReranker::new(
            Some("test-key".to_string()),
            "https://example.com/api/v1".to_string(),
        );
        assert_eq!(reranker.base_url, "https://example.com/api/v1");
    }

    #[test]
    fn test_langsearch_reranker_creation() {
        let reranker = LangSearchReranker::new(Some("test-key".to_string()), String::new(), None);
        assert_eq!(reranker.model, "langsearch-reranker-v1");
        assert_eq!(reranker.base_url, "https://api.langsearch.com/v1");
    }

    #[test]
    fn test_langsearch_reranker_custom_model() {
        let reranker = LangSearchReranker::new(
            Some("test-key".to_string()),
            "custom-model".to_string(),
            Some("https://custom.api.com/v1".to_string()),
        );
        assert_eq!(reranker.model, "custom-model");
        assert_eq!(reranker.base_url, "https://custom.api.com/v1");
    }

    #[tokio::test]
    async fn test_reranker_empty_documents() {
        let reranker = JinaReranker::new(
            Some("test-key".to_string()),
            "jina-reranker-v2-base-multilingual".to_string(),
        );
        let results = reranker.rerank("test query", Vec::new()).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_compass_reranker_empty_documents() {
        let reranker = CompassReranker::new(
            Some("test-key".to_string()),
            "https://example.com/api/v1".to_string(),
        );
        let results = reranker.rerank("test query", Vec::new()).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_langsearch_reranker_empty_documents() {
        let reranker = LangSearchReranker::new(Some("test-key".to_string()), String::new(), None);
        let results = reranker.rerank("test query", Vec::new()).await.unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_create_reranker_compass() {
        let reranker = create_reranker(
            "compass",
            Some("key".to_string()),
            String::new(),
            Some("https://example.com/api/v1".to_string()),
        );
        assert!(reranker.is_ok());
    }

    #[test]
    fn test_create_reranker_langsearch() {
        let reranker = create_reranker("langsearch", Some("key".to_string()), String::new(), None);
        assert!(reranker.is_ok());
    }

    #[test]
    fn test_create_reranker_unknown() {
        let reranker = create_reranker("unknown", None, String::new(), None);
        assert!(reranker.is_err());
    }
}
