use anyhow::Result;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

// RAG search implementation
use crate::rag::bm25::BM25Index;
use crate::rag::config::RagConfig;
use crate::rag::{Database, SearchResult};
use crate::rag::embedding;
use crate::rag::hybrid_search::{hybrid_search, HybridSearchResult, SearchMode};
use crate::rag::reranker::create_reranker;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub results: Vec<SearchResultItem>,
    pub total_indexed: i64,
    pub query_time_ms: u64,
    pub search_mode: String,
    pub degraded: bool,
    pub reranked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rerank_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultItem {
    pub content: String,
    pub source: String,
    pub heading: Option<String>,
    pub score: f64,
    pub chunk_index: i64,
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
}

pub async fn search(
    db: &Database,
    embedding_provider: &Arc<dyn embedding::EmbeddingProvider>,
    bm25_index: Option<&BM25Index>,
    config: &RagConfig,
    query: &str,
    top_k: usize,
    mode: SearchMode,
    min_score: Option<f64>,
) -> Result<SearchResponse> {
    let start = std::time::Instant::now();

    let total_indexed = db.get_total_chunk_count().await?;

    if total_indexed == 0 {
        return Ok(SearchResponse {
            results: Vec::new(),
            total_indexed: 0,
            query_time_ms: start.elapsed().as_millis() as u64,
            search_mode: format!("{:?}", mode),
            degraded: false,
            reranked: false,
            rerank_error: None,
        });
    }

    // Perform hybrid search (fetch more if reranking is enabled)
    let fetch_k = if config.rerank_enabled {
        config.rerank_top_k.max(top_k * 2)
    } else {
        top_k
    };

    // Track if search was degraded
    let mut degraded = false;
    let mut actual_mode = mode;

    let hybrid_results = match hybrid_search(
        db,
        embedding_provider,
        bm25_index,
        query,
        fetch_k,
        mode,
        config.hybrid_weight,
    )
    .await {
        Ok(results) => results,
        Err(e) => {
            // If hybrid/semantic search completely failed and no fallback worked
            tracing::error!("Search failed: {}", e);
            
            // Last resort: try pure BM25 if available
            if let Some(bm25) = bm25_index {
                tracing::warn!("Attempting last resort BM25 search");
                degraded = true;
                actual_mode = SearchMode::BM25;
                
                let bm25_results = bm25.search(query, fetch_k).await
                    .map_err(|e2| anyhow::anyhow!("All search methods failed. Original: {}, BM25: {}", e, e2))?;
                
                bm25_results
                    .into_iter()
                    .map(|(chunk_id, score)| HybridSearchResult { chunk_id, score })
                    .collect()
            } else {
                return Err(e);
            }
        }
    };

    // Convert hybrid results to SearchResultItem by fetching full chunk data
    let chunk_ids: Vec<i64> = hybrid_results.iter().map(|r| r.chunk_id).collect();
    let chunk_map: HashMap<i64, SearchResult> = db
        .get_chunks_by_ids(&chunk_ids)
        .await?
        .into_iter()
        .map(|r| (r.chunk_id, r))
        .collect();

    // Convert to intermediate results with content
    let intermediate_results: Vec<(i64, SearchResultItem, f64)> = hybrid_results
        .into_iter()
        .filter_map(|hybrid_result| {
            chunk_map.get(&hybrid_result.chunk_id).map(|chunk| {
                (
                    hybrid_result.chunk_id,
                    SearchResultItem {
                        content: chunk.content.clone(),
                        source: chunk.source.clone(),
                        heading: chunk.heading.clone(),
                        score: hybrid_result.score,
                        chunk_index: chunk.chunk_index,
                        start_line: chunk.start_line,
                        end_line: chunk.end_line,
                    },
                    hybrid_result.score,
                )
            })
        })
        .collect();

    let mut reranked = false;
    let mut rerank_error: Option<String> = None;

    let mut results: Vec<SearchResultItem> = if config.rerank_enabled {
        tracing::info!(
            "[RAG] Reranking enabled (provider={}, base_url={}, docs={})",
            config.rerank_provider,
            config.rerank_base_url,
            intermediate_results.len()
        );
        match apply_reranking(query, &intermediate_results, top_k, config).await {
            Ok(reranked_results) => {
                reranked = true;
                tracing::info!("[RAG] Reranking succeeded, {} results", reranked_results.len());
                reranked_results
            }
            Err(e) => {
                let err_msg = format!("{:#}", e);
                tracing::error!("[RAG] Reranking FAILED: {}", err_msg);
                rerank_error = Some(err_msg);
                intermediate_results
                    .into_iter()
                    .take(top_k)
                    .map(|(_, item, _)| item)
                    .collect()
            }
        }
    } else {
        intermediate_results
            .into_iter()
            .map(|(_, item, _)| item)
            .collect()
    };

    if let Some(threshold) = min_score {
        results.retain(|item| item.score >= threshold);
    }

    let search_mode_str = if degraded {
        format!("{:?} (degraded to {:?})", mode, actual_mode)
    } else {
        format!("{:?}", actual_mode)
    };

    Ok(SearchResponse {
        results,
        total_indexed,
        query_time_ms: start.elapsed().as_millis() as u64,
        search_mode: search_mode_str,
        degraded,
        reranked,
        rerank_error,
    })
}

/// Apply reranking to intermediate results
async fn apply_reranking(
    query: &str,
    intermediate_results: &[(i64, SearchResultItem, f64)],
    top_k: usize,
    config: &RagConfig,
) -> Result<Vec<SearchResultItem>> {
    // Create reranker
    let base_url = if config.rerank_base_url.is_empty() {
        None
    } else {
        Some(config.rerank_base_url.clone())
    };
    let reranker = create_reranker(
        &config.rerank_provider,
        config.rerank_api_key.clone(),
        config.rerank_model.clone(),
        base_url,
    )?;

    // Extract documents (content) for reranking
    let documents: Vec<&str> = intermediate_results
        .iter()
        .map(|(_, item, _)| item.content.as_str())
        .collect();

    // Call reranker
    let rerank_results = reranker.rerank(query, documents).await?;

    // Map reranked indices back to our results and sort by rerank score
    let mut reranked: Vec<(SearchResultItem, f64)> = Vec::new();
    for (index, score) in rerank_results {
        if let Some((_, item, _)) = intermediate_results.get(index) {
            let mut reranked_item = item.clone();
            reranked_item.score = score;
            reranked.push((reranked_item, score));
        }
    }

    // Sort by rerank score descending
    reranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Take top_k
    Ok(reranked.into_iter().take(top_k).map(|(item, _)| item).collect())
}
