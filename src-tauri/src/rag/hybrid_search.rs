use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;

use crate::rag::bm25::BM25Index;
use crate::rag::db::Database;
use crate::rag::embedding;

/// Search mode: semantic, BM25, or hybrid
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Semantic,
    BM25,
    Hybrid,
}

impl SearchMode {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "semantic" => Self::Semantic,
            "bm25" => Self::BM25,
            "hybrid" => Self::Hybrid,
            _ => Self::Hybrid, // default
        }
    }
}

/// Result from hybrid search
#[derive(Debug, Clone)]
pub struct HybridSearchResult {
    pub chunk_id: i64,
    pub score: f64,
}

/// Perform hybrid search combining semantic and BM25
/// Auto-degrades to BM25-only if embedding fails, or semantic-only if BM25 unavailable
pub async fn hybrid_search(
    db: &Database,
    embedding_provider: &Arc<dyn embedding::EmbeddingProvider>,
    bm25_index: Option<&BM25Index>,
    query: &str,
    top_k: usize,
    mode: SearchMode,
    hybrid_weight: f64, // weight for semantic (0-1), BM25 weight = 1 - hybrid_weight
) -> Result<Vec<HybridSearchResult>> {
    match mode {
        SearchMode::Semantic => {
            // Pure semantic search
            match semantic_search_internal(db, embedding_provider, query, top_k).await {
                Ok(semantic_results) => {
                    Ok(semantic_results
                        .into_iter()
                        .map(|(chunk_id, score)| HybridSearchResult {
                            chunk_id,
                            // Clamp to ensure 0-1 range (should already be in range from cosine similarity)
                            score: score.min(1.0).max(0.0),
                        })
                        .collect())
                }
                Err(e) => {
                    // Embedding failed, fallback to BM25 if available
                    tracing::warn!("Semantic search failed ({}), falling back to BM25", e);
                    if let Some(bm25) = bm25_index {
                        let bm25_results = bm25.search(query, top_k).await?;
                        let bm25_k = 3.0;

                        Ok(bm25_results
                            .into_iter()
                            .filter(|(_, score)| *score > 0.0)
                            .map(|(chunk_id, score)| HybridSearchResult {
                                chunk_id,
                                score: score / (score + bm25_k),
                            })
                            .collect())
                    } else {
                        Err(e) // No fallback available
                    }
                }
            }
        }
        SearchMode::BM25 => {
            // Pure BM25 search
            if let Some(bm25) = bm25_index {
                let bm25_results = bm25.search(query, top_k).await?;
                let bm25_k = 3.0;

                Ok(bm25_results
                    .into_iter()
                    .filter(|(_, score)| *score > 0.0)
                    .map(|(chunk_id, score)| HybridSearchResult {
                        chunk_id,
                        score: score / (score + bm25_k),
                    })
                    .collect())
            } else {
                // Fallback to semantic if BM25 not available
                tracing::warn!("BM25 index not available, falling back to semantic search");
                let semantic_results =
                    semantic_search_internal(db, embedding_provider, query, top_k).await?;
                Ok(semantic_results
                    .into_iter()
                    .map(|(chunk_id, score)| HybridSearchResult { chunk_id, score })
                    .collect())
            }
        }
        SearchMode::Hybrid => {
            // Hybrid search with weighted score fusion
            if let Some(bm25) = bm25_index {
                // Try hybrid search, fallback to BM25 if embedding fails
                match hybrid_search_weighted(
                    db,
                    embedding_provider,
                    bm25,
                    query,
                    top_k,
                    hybrid_weight,
                )
                .await
                {
                    Ok(results) => Ok(results),
                    Err(e) => {
                        // Hybrid failed (likely embedding issue), fallback to BM25-only
                        tracing::warn!("Hybrid search failed ({}), falling back to BM25-only", e);
                        let bm25_results = bm25.search(query, top_k).await?;
                        let bm25_k = 3.0;

                        Ok(bm25_results
                            .into_iter()
                            .filter(|(_, score)| *score > 0.0)
                            .map(|(chunk_id, score)| HybridSearchResult {
                                chunk_id,
                                score: score / (score + bm25_k),
                            })
                            .collect())
                    }
                }
            } else {
                // BM25 not available, try semantic-only
                tracing::warn!("BM25 index not available, falling back to semantic search");
                let semantic_results =
                    semantic_search_internal(db, embedding_provider, query, top_k).await?;
                Ok(semantic_results
                    .into_iter()
                    .map(|(chunk_id, score)| HybridSearchResult { chunk_id, score })
                    .collect())
            }
        }
    }
}

/// Internal semantic search that returns (chunk_id, score)
async fn semantic_search_internal(
    db: &Database,
    embedding_provider: &Arc<dyn embedding::EmbeddingProvider>,
    query: &str,
    top_k: usize,
) -> Result<Vec<(i64, f64)>> {
    // Generate query embedding
    let query_embeddings = embedding_provider.embed(vec![query.to_string()]).await?;
    let query_embedding = &query_embeddings[0];

    // Perform vector search (returns expanded top_k for RRF)
    let db_results = db.vector_search(query_embedding, top_k * 3).await?;

    Ok(db_results
        .into_iter()
        .map(|r| (r.chunk_id, r.score))
        .collect())
}

/// Hybrid search using Reciprocal Rank Fusion (RRF)
/// Not used: RRF normalizes by rank, causing irrelevant results to score high when no good matches exist.
#[allow(dead_code)]
async fn hybrid_search_rrf(
    db: &Database,
    embedding_provider: &Arc<dyn embedding::EmbeddingProvider>,
    bm25: &BM25Index,
    query: &str,
    top_k: usize,
    semantic_weight: f64,
) -> Result<Vec<HybridSearchResult>> {
    // Fetch more results for better fusion
    let fetch_k = (top_k * 3).max(50);

    // Run both searches in parallel
    let (semantic_results, bm25_results) = tokio::join!(
        semantic_search_internal(db, embedding_provider, query, fetch_k),
        bm25.search(query, fetch_k)
    );

    let semantic_results: Vec<(i64, f64)> = semantic_results?;
    let bm25_results: Vec<(i64, f64)> = bm25_results?;

    // Apply RRF (Reciprocal Rank Fusion)
    let mut scores: HashMap<i64, f64> = HashMap::new();
    let k_constant = 60.0; // RRF constant

    // Add semantic scores
    for (rank, (chunk_id, _score)) in semantic_results.iter().enumerate() {
        let rrf_score = semantic_weight / (k_constant + (rank as f64 + 1.0));
        *scores.entry(*chunk_id).or_insert(0.0) += rrf_score;
    }

    // Add BM25 scores
    let bm25_weight = 1.0 - semantic_weight;
    for (rank, (chunk_id, _score)) in bm25_results.iter().enumerate() {
        let rrf_score = bm25_weight / (k_constant + (rank as f64 + 1.0));
        *scores.entry(*chunk_id).or_insert(0.0) += rrf_score;
    }

    // Sort by combined score and take top_k
    let mut results: Vec<HybridSearchResult> = scores
        .into_iter()
        .map(|(chunk_id, score)| HybridSearchResult { chunk_id, score })
        .collect();

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(top_k);

    // Normalize RRF scores to 0-1 range based on max score
    if !results.is_empty() {
        let max_score = results
            .iter()
            .map(|r| r.score)
            .fold(f64::NEG_INFINITY, f64::max);
        if max_score > 0.0 {
            for result in &mut results {
                result.score = (result.score / max_score).min(1.0);
            }
        }
    }

    Ok(results)
}

/// Weighted score fusion: combines semantic (cosine similarity, already [0,1]) and BM25 (mapped
/// to [0,1) via saturation function) using configurable weights. Both score sources have absolute
/// meaning — low relevance stays low regardless of what other results look like.
async fn hybrid_search_weighted(
    db: &Database,
    embedding_provider: &Arc<dyn embedding::EmbeddingProvider>,
    bm25: &BM25Index,
    query: &str,
    top_k: usize,
    semantic_weight: f64,
) -> Result<Vec<HybridSearchResult>> {
    let fetch_k = (top_k * 2).max(30);

    let (semantic_results, bm25_results) = tokio::join!(
        semantic_search_internal(db, embedding_provider, query, fetch_k),
        bm25.search(query, fetch_k)
    );

    let semantic_results: Vec<(i64, f64)> = semantic_results?;
    let bm25_results: Vec<(i64, f64)> = bm25_results?;

    // Semantic scores (cosine similarity) are already in [0,1] — use as-is
    let semantic_scores: HashMap<i64, f64> = semantic_results
        .iter()
        .map(|(chunk_id, score)| (*chunk_id, score.min(1.0).max(0.0)))
        .collect();

    // BM25 scores are unbounded — map to [0,1) via saturation: score / (score + k)
    // k=3 means a BM25 score of 3 maps to 0.5; higher scores approach 1 asymptotically
    let bm25_saturation_k = 3.0;
    let bm25_scores: HashMap<i64, f64> = bm25_results
        .iter()
        .filter(|(_, score)| *score > 0.0)
        .map(|(chunk_id, score)| (*chunk_id, score / (score + bm25_saturation_k)))
        .collect();

    // Combine with weights
    let mut combined_scores: HashMap<i64, f64> = HashMap::new();
    let bm25_weight = 1.0 - semantic_weight;

    for (chunk_id, score) in &semantic_scores {
        *combined_scores.entry(*chunk_id).or_insert(0.0) += semantic_weight * score;
    }

    for (chunk_id, score) in &bm25_scores {
        *combined_scores.entry(*chunk_id).or_insert(0.0) += bm25_weight * score;
    }

    let mut results: Vec<HybridSearchResult> = combined_scores
        .into_iter()
        .map(|(chunk_id, score)| HybridSearchResult {
            chunk_id,
            score: score.min(1.0).max(0.0),
        })
        .collect();

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(top_k);

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_search_mode_from_str() {
        assert_eq!(SearchMode::from_str("semantic"), SearchMode::Semantic);
        assert_eq!(SearchMode::from_str("bm25"), SearchMode::BM25);
        assert_eq!(SearchMode::from_str("hybrid"), SearchMode::Hybrid);
        assert_eq!(SearchMode::from_str("unknown"), SearchMode::Hybrid);
    }
}
