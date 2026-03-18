use anyhow::{Context, Result};
use std::path::Path;
use std::sync::Arc;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::*;
use tantivy::tokenizer::{NgramTokenizer, TextAnalyzer};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy};
use tokio::sync::RwLock;

/// BM25 full-text search index using Tantivy
#[derive(Clone)]
pub struct BM25Index {
    index: Arc<Index>,
    reader: Arc<IndexReader>,
    writer: Arc<RwLock<IndexWriter>>,
    #[allow(dead_code)]
    schema: Arc<Schema>,
    chunk_id_field: Field,
    content_field: Field,
    title_field: Field,
    heading_field: Field,
}

impl BM25Index {
    /// Create or open a BM25 index at the given path
    pub fn new(index_path: &Path) -> Result<Self> {
        // Ensure the directory exists
        std::fs::create_dir_all(index_path)
            .context("Failed to create BM25 index directory")?;

        // Define schema with Chinese-friendly text options
        let text_options = TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("ngram3") // Use ngram tokenizer for Chinese
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        ).set_stored();
        
        let mut schema_builder = Schema::builder();
        let chunk_id_field = schema_builder.add_i64_field("chunk_id", STORED | INDEXED);
        let content_field = schema_builder.add_text_field("content", text_options.clone());
        let title_field = schema_builder.add_text_field("title", text_options.clone());
        let heading_field = schema_builder.add_text_field("heading", text_options);
        let schema = schema_builder.build();

        // Open or create index
        let index = if index_path.join("meta.json").exists() {
            match Index::open_in_dir(index_path) {
                Ok(idx) => idx,
                Err(e) => {
                    // Failed to open existing index (schema mismatch?)
                    eprintln!("Failed to open existing BM25 index, recreating: {}", e);
                    
                    // Remove corrupted index and create fresh one
                    if let Err(remove_err) = std::fs::remove_dir_all(index_path) {
                        eprintln!("Warning: Failed to remove corrupted index: {}", remove_err);
                    }
                    std::fs::create_dir_all(index_path)
                        .context("Failed to recreate BM25 index directory")?;
                    
                    Index::create_in_dir(index_path, schema.clone())
                        .context("Failed to create new index after corruption")?
                }
            }
        } else {
            Index::create_in_dir(index_path, schema.clone())
                .context("Failed to create new index")?
        };

        // Register ngram tokenizer for Chinese text
        let ngram_tokenizer = TextAnalyzer::builder(
            NgramTokenizer::new(2, 3, false).unwrap()
        )
        .build();
        index.tokenizers().register("ngram3", ngram_tokenizer);

        // Create reader with auto-reload
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .context("Failed to create index reader")?;

        // Create writer (single threaded for simplicity)
        let writer = index
            .writer(50_000_000)
            .context("Failed to create index writer")?;

        Ok(Self {
            index: Arc::new(index),
            reader: Arc::new(reader),
            writer: Arc::new(RwLock::new(writer)),
            schema: Arc::new(schema),
            chunk_id_field,
            content_field,
            title_field,
            heading_field,
        })
    }

    /// Add a document to the BM25 index
    pub async fn add_document(
        &self,
        chunk_id: i64,
        content: &str,
        title: Option<&str>,
        heading: Option<&str>,
    ) -> Result<()> {
        let writer = self.writer.write().await;

        let mut doc = doc!(
            self.chunk_id_field => chunk_id,
            self.content_field => content,
        );

        if let Some(title) = title {
            doc.add_text(self.title_field, title);
        }

        if let Some(heading) = heading {
            doc.add_text(self.heading_field, heading);
        }

        writer
            .add_document(doc)
            .context("Failed to add document to index")?;

        Ok(())
    }

    /// Delete a document by chunk_id
    #[allow(dead_code)]
    pub async fn delete_document(&self, chunk_id: i64) -> Result<()> {
        let writer = self.writer.write().await;
        let term = Term::from_field_i64(self.chunk_id_field, chunk_id);
        writer.delete_term(term);
        Ok(())
    }

    /// Commit pending changes
    pub async fn commit(&self) -> Result<()> {
        let mut writer = self.writer.write().await;
        writer
            .commit()
            .context("Failed to commit index changes")?;
        Ok(())
    }

    /// Search the BM25 index and return top_k results
    /// Returns Vec<(chunk_id, score)>
    pub async fn search(&self, query: &str, top_k: usize) -> Result<Vec<(i64, f64)>> {
        let searcher = self.reader.searcher();
        let num_docs = searcher.num_docs();

        // Parse query across content, title, and heading fields
        // The QueryParser will automatically use the tokenizer registered with the index
        let query_parser = QueryParser::for_index(
            &self.index,
            vec![self.content_field, self.title_field, self.heading_field],
        );

        let parsed_query = query_parser
            .parse_query(query)
            .context("Failed to parse query")?;

        tracing::debug!(
            "BM25 search: query='{}', num_docs={}, parsed_query={:?}",
            query, num_docs, parsed_query
        );

        // Execute search
        let top_docs = searcher
            .search(&parsed_query, &TopDocs::with_limit(top_k))
            .context("Failed to execute search")?;

        tracing::debug!("BM25 search found {} results", top_docs.len());

        // Extract chunk_id and scores
        let results: Vec<(i64, f64)> = top_docs
            .into_iter()
            .filter_map(|(score, doc_address)| {
                let doc: tantivy::TantivyDocument = searcher.doc(doc_address).ok()?;
                let chunk_id = doc.get_first(self.chunk_id_field)?.as_i64()?;
                Some((chunk_id, score as f64))
            })
            .collect();

        Ok(results)
    }

    /// Get the number of indexed documents
    pub async fn num_docs(&self) -> u64 {
        let searcher = self.reader.searcher();
        searcher.num_docs()
    }

    /// Clear all documents from the index
    #[allow(dead_code)]
    pub async fn clear(&self) -> Result<()> {
        let mut writer = self.writer.write().await;
        writer.delete_all_documents()?;
        writer.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_bm25_index_basic() {
        let temp_dir = TempDir::new().unwrap();
        let index = BM25Index::new(temp_dir.path()).unwrap();

        // Add documents
        index
            .add_document(1, "Rust programming language", Some("Rust"), None)
            .await
            .unwrap();
        index
            .add_document(2, "Python programming language", Some("Python"), None)
            .await
            .unwrap();
        index.commit().await.unwrap();

        // Search
        let results = index.search("Rust", 10).await.unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].0, 1);
    }

    #[tokio::test]
    async fn test_bm25_delete() {
        let temp_dir = TempDir::new().unwrap();
        let index = BM25Index::new(temp_dir.path()).unwrap();

        index
            .add_document(1, "Test document", None, None)
            .await
            .unwrap();
        index.commit().await.unwrap();

        index.delete_document(1).await.unwrap();
        index.commit().await.unwrap();

        let results = index.search("Test", 10).await.unwrap();
        assert!(results.is_empty());
    }
}
