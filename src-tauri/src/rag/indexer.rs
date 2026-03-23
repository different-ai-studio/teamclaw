use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use walkdir::WalkDir;

use crate::rag::bm25::BM25Index;
use crate::rag::chunker;
use crate::rag::code_chunker;
use crate::rag::config::RagConfig;
use crate::rag::db::Database;
use crate::rag::embedding;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub indexed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub total_chunks: i64,
    pub duration_ms: u64,
}

pub struct Indexer {
    db: Database,
    embedding: Arc<dyn embedding::EmbeddingProvider>,
    bm25_index: Option<BM25Index>,
    config: RagConfig,
    workspace_path: PathBuf,
}

impl Indexer {
    pub fn new(
        db: Database,
        embedding: Arc<dyn embedding::EmbeddingProvider>,
        bm25_index: Option<BM25Index>,
        config: RagConfig,
        workspace_path: PathBuf,
    ) -> Self {
        Self {
            db,
            embedding,
            bm25_index,
            config,
            workspace_path,
        }
    }

    /// Index documents from the knowledge directory or a specific path
    pub async fn index_directory(&self, path: Option<&str>) -> Result<IndexResult> {
        self.index_directory_internal(path, false).await
    }

    /// Force re-index all documents, ignoring file hash checks
    /// This will clear ALL chunks (embeddings) and BM25 index, then rebuild from scratch
    pub async fn force_reindex_all(&self) -> Result<IndexResult> {
        tracing::info!("Starting force reindex - clearing all embeddings and BM25 index");

        // Clear all chunks (this removes all vector embeddings from the database)
        if let Err(e) = self.db.clear_all_chunks().await {
            tracing::error!("Failed to clear chunks: {}", e);
            return Err(e);
        }
        tracing::info!("Cleared all chunks (vector embeddings)");

        // Clear BM25 index (done at command level before recreating instance)

        // Now rebuild everything
        self.index_directory_internal(None, true).await
    }

    async fn index_directory_internal(
        &self,
        path: Option<&str>,
        force: bool,
    ) -> Result<IndexResult> {
        let start = Instant::now();

        // Collect all files to index
        let files = if let Some(p) = path {
            // Specific path provided - could be file or directory
            let scan_path = PathBuf::from(p);
            if !scan_path.exists() {
                bail!(
                    "Path does not exist: {}. Create it and add documents to index.",
                    scan_path.display()
                );
            }

            if scan_path.is_file() {
                // Single file mode
                let ext = scan_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if !is_supported_extension(ext) {
                    bail!(
                        "Unsupported file extension: '{}'. Supported: .md, .txt, .rs, .ts, .tsx, .py, .go",
                        ext
                    );
                }
                vec![scan_path.clone()]
            } else {
                scan_directory(&scan_path)?
            }
        } else {
            // No path provided - scan all configured knowledge directories
            let knowledge_dirs = self.config.knowledge_dirs(&self.workspace_path);
            let mut all_files = Vec::new();

            for knowledge_dir in &knowledge_dirs {
                if !knowledge_dir.exists() {
                    tracing::warn!(
                        "Knowledge directory does not exist, skipping: {:?}",
                        knowledge_dir
                    );
                    continue;
                }

                match scan_directory(knowledge_dir) {
                    Ok(files) => all_files.extend(files),
                    Err(e) => {
                        tracing::error!("Failed to scan directory {:?}: {}", knowledge_dir, e);
                    }
                }
            }

            all_files
        };

        let mut indexed = 0usize;
        let mut skipped = 0usize;
        let mut failed = 0usize;

        // Track which files we've seen (for deleted file detection)
        let mut seen_paths: HashSet<String> = HashSet::new();

        for file_path in &files {
            let relative_path = self.relative_path(file_path);
            seen_paths.insert(relative_path.clone());

            match self
                .process_file_internal(file_path, &relative_path, force)
                .await
            {
                Ok(ProcessResult::Indexed) => indexed += 1,
                Ok(ProcessResult::Skipped) => skipped += 1,
                Err(e) => {
                    tracing::error!("Failed to index {}: {}", relative_path, e);
                    failed += 1;
                }
            }
        }

        // Clean up deleted files (only when scanning full directory, not single file)
        let scan_path = path.map(PathBuf::from);
        if path.is_none() || scan_path.as_ref().map(|p| p.is_dir()).unwrap_or(false) {
            if let Err(e) = self.cleanup_deleted_files(&seen_paths).await {
                tracing::error!("Failed to cleanup deleted files: {}", e);
            }
        }

        let total_chunks = self.db.get_total_chunk_count().await.unwrap_or(0);

        Ok(IndexResult {
            indexed,
            skipped,
            failed,
            total_chunks,
            duration_ms: start.elapsed().as_millis() as u64,
        })
    }

    /// Process a single file: check hash, parse, chunk, embed, store
    async fn process_file_internal(
        &self,
        file_path: &Path,
        relative_path: &str,
        force: bool,
    ) -> Result<ProcessResult> {
        // Read file content
        let content = tokio::fs::read_to_string(file_path)
            .await
            .context("Failed to read file")?;

        let file_size = content.len() as i64;

        // Compute SHA-256 hash
        let hash = compute_hash(&content);

        // Check if document exists and hash matches
        if let Some(existing) = self.db.get_document_by_path(relative_path).await? {
            if !force && existing.hash == hash {
                return Ok(ProcessResult::Skipped);
            }

            // Hash changed or force mode — delete old chunks and re-index
            if force {
                tracing::info!("Force re-indexing: {}", relative_path);
            } else {
                tracing::info!("File modified, re-indexing: {}", relative_path);
            }

            // Delete old BM25 entries BEFORE deleting chunks from DB
            // (we need the chunk IDs to delete from BM25)
            if let Some(bm25) = &self.bm25_index {
                let old_chunks = self.db.get_chunks_by_doc_id(existing.id).await?;
                tracing::info!("Deleting {} old chunks from BM25 index", old_chunks.len());
                for chunk in old_chunks {
                    if let Err(e) = bm25.delete_document(chunk.chunk_id).await {
                        tracing::warn!(
                            "Failed to delete chunk {} from BM25: {}",
                            chunk.chunk_id,
                            e
                        );
                    }
                }
                if let Err(e) = bm25.commit().await {
                    tracing::warn!("Failed to commit BM25 deletions: {}", e);
                }
            }

            self.db.delete_chunks_by_doc_id(existing.id).await?;

            // Parse and chunk
            let (chunks, title) = self.parse_and_chunk(file_path, &content)?;

            if chunks.is_empty() {
                self.db
                    .update_document(existing.id, &hash, file_size, 0, title.as_deref())
                    .await?;
                return Ok(ProcessResult::Indexed);
            }

            // Generate embeddings
            let texts: Vec<String> = chunks.iter().map(|c| c.content.clone()).collect();
            let embeddings = self.embedding.embed(texts).await?;

            // Store chunks
            let chunk_data: Vec<(
                String,
                i32,
                Option<String>,
                Vec<f32>,
                Option<String>,
                Option<String>,
                Option<i64>,
                Option<i64>,
            )> = chunks
                .iter()
                .zip(embeddings.iter())
                .map(|(chunk, emb)| {
                    (
                        chunk.content.clone(),
                        chunk.chunk_index,
                        chunk.heading.clone(),
                        emb.clone(),
                        chunk.chunk_type.clone(),
                        chunk.name.clone(),
                        chunk.start_line.map(|l| l as i64),
                        chunk.end_line.map(|l| l as i64),
                    )
                })
                .collect();

            self.db.insert_chunks(existing.id, &chunk_data).await?;
            self.db
                .update_document(
                    existing.id,
                    &hash,
                    file_size,
                    chunks.len() as i64,
                    title.as_deref(),
                )
                .await?;

            // Update BM25 index
            self.sync_bm25_for_document(existing.id, title.as_deref())
                .await?;

            Ok(ProcessResult::Indexed)
        } else {
            // New file
            tracing::info!("New file, indexing: {}", relative_path);

            let format = file_extension(file_path);
            let (chunks, title) = self.parse_and_chunk(file_path, &content)?;

            if chunks.is_empty() {
                self.db
                    .insert_document(
                        relative_path,
                        title.as_deref(),
                        &format,
                        &hash,
                        file_size,
                        0,
                    )
                    .await?;
                return Ok(ProcessResult::Indexed);
            }

            // Generate embeddings
            let texts: Vec<String> = chunks.iter().map(|c| c.content.clone()).collect();
            let embeddings = self.embedding.embed(texts).await?;

            // Store document
            let doc_id = self
                .db
                .insert_document(
                    relative_path,
                    title.as_deref(),
                    &format,
                    &hash,
                    file_size,
                    chunks.len() as i64,
                )
                .await?;

            // Store chunks
            let chunk_data: Vec<(
                String,
                i32,
                Option<String>,
                Vec<f32>,
                Option<String>,
                Option<String>,
                Option<i64>,
                Option<i64>,
            )> = chunks
                .iter()
                .zip(embeddings.iter())
                .map(|(chunk, emb)| {
                    (
                        chunk.content.clone(),
                        chunk.chunk_index,
                        chunk.heading.clone(),
                        emb.clone(),
                        chunk.chunk_type.clone(),
                        chunk.name.clone(),
                        chunk.start_line.map(|l| l as i64),
                        chunk.end_line.map(|l| l as i64),
                    )
                })
                .collect();

            self.db.insert_chunks(doc_id, &chunk_data).await?;

            // Update BM25 index
            self.sync_bm25_for_document(doc_id, title.as_deref())
                .await?;

            Ok(ProcessResult::Indexed)
        }
    }

    /// Parse a file and return chunks + title
    fn parse_and_chunk(
        &self,
        file_path: &Path,
        content: &str,
    ) -> Result<(Vec<chunker::Chunk>, Option<String>)> {
        let ext = file_extension(file_path);
        match ext.as_str() {
            "md" => {
                let title = chunker::extract_title(content);
                let chunks = chunker::chunk_markdown(
                    content,
                    self.config.chunk_size,
                    self.config.chunk_overlap,
                );
                Ok((chunks, title))
            }
            "txt" => {
                let chunks = chunker::chunk_plain_text(
                    content,
                    self.config.chunk_size,
                    self.config.chunk_overlap,
                );
                Ok((chunks, None))
            }
            "rs" | "ts" | "tsx" | "py" | "go" => {
                // Code files - use code-aware chunking
                let code_chunks = code_chunker::chunk_code(&ext, content)?;
                let chunks = code_chunks
                    .into_iter()
                    .enumerate()
                    .map(|(i, cc)| chunker::Chunk {
                        content: cc.content.clone(),
                        chunk_index: i as i32,
                        heading: None, // Code files use start_line for navigation, not heading
                        chunk_type: Some(cc.chunk_type.clone()),
                        name: Some(cc.name.clone()),
                        start_line: Some(cc.start_line),
                        end_line: Some(cc.end_line),
                    })
                    .collect();
                Ok((chunks, None))
            }
            other => {
                bail!("Unsupported format: {}", other);
            }
        }
    }

    /// Cleanup documents whose files no longer exist on disk
    async fn cleanup_deleted_files(&self, seen_paths: &HashSet<String>) -> Result<()> {
        let all_docs = self.db.list_all_document_paths().await?;

        for (id, path) in all_docs {
            if !seen_paths.contains(&path) {
                tracing::info!("File deleted, removing from index: {}", path);

                // Delete from BM25 index first (before deleting from DB)
                if let Some(bm25) = &self.bm25_index {
                    let chunks = self.db.get_chunks_by_doc_id(id).await?;
                    for chunk in chunks {
                        if let Err(e) = bm25.delete_document(chunk.chunk_id).await {
                            tracing::warn!(
                                "Failed to delete chunk {} from BM25: {}",
                                chunk.chunk_id,
                                e
                            );
                        }
                    }
                    if let Err(e) = bm25.commit().await {
                        tracing::warn!("Failed to commit BM25 deletions: {}", e);
                    }
                }

                // Then delete from database (cascades to chunks)
                self.db.delete_document(id).await?;
            }
        }

        Ok(())
    }

    /// Delete a file from the index immediately
    pub async fn delete_file(&self, relative_path: &str) -> Result<()> {
        if let Some(doc) = self.db.get_document_by_path(relative_path).await? {
            tracing::info!("File deleted, removing from index: {}", relative_path);

            // Get all chunk IDs for BM25 cleanup
            if let Some(bm25) = &self.bm25_index {
                let chunks = self.db.get_chunks_by_doc_id(doc.id).await?;
                for chunk in chunks {
                    if let Err(e) = bm25.delete_document(chunk.chunk_id).await {
                        tracing::warn!(
                            "Failed to delete chunk {} from BM25: {}",
                            chunk.chunk_id,
                            e
                        );
                    }
                }
                // Commit BM25 changes
                if let Err(e) = bm25.commit().await {
                    tracing::warn!("Failed to commit BM25 index after deletion: {}", e);
                }
            }

            // Delete from database (cascades to chunks)
            self.db.delete_document(doc.id).await?;
            tracing::info!("Successfully removed {} from index", relative_path);
        }
        Ok(())
    }

    /// Get relative path from knowledge dir
    /// Tries to strip prefix from all configured knowledge directories
    fn relative_path(&self, file_path: &Path) -> String {
        let knowledge_dirs = self.config.knowledge_dirs(&self.workspace_path);

        // Try to find which knowledge directory this file belongs to
        for knowledge_dir in &knowledge_dirs {
            if let Ok(relative) = file_path.strip_prefix(knowledge_dir) {
                return relative.to_string_lossy().to_string();
            }
        }

        // Fallback: return the full path if not in any knowledge directory
        file_path.to_string_lossy().to_string()
    }

    /// Sync BM25 index for a document (after inserting/updating chunks in DB)
    async fn sync_bm25_for_document(&self, doc_id: i64, title: Option<&str>) -> Result<()> {
        if let Some(bm25) = &self.bm25_index {
            // Get all chunks for this document from DB
            let chunks = self.db.get_chunks_by_doc_id(doc_id).await?;

            tracing::info!(
                "Syncing {} chunks to BM25 index for doc_id={}",
                chunks.len(),
                doc_id
            );

            // Add each chunk to BM25 index
            for chunk in &chunks {
                if let Err(e) = bm25
                    .add_document(
                        chunk.chunk_id,
                        &chunk.content,
                        title,
                        chunk.heading.as_deref(),
                    )
                    .await
                {
                    tracing::error!(
                        "Failed to add chunk {} to BM25 index: {}",
                        chunk.chunk_id,
                        e
                    );
                    return Err(e);
                }
            }

            // Commit BM25 changes
            if let Err(e) = bm25.commit().await {
                tracing::error!("Failed to commit BM25 index: {}", e);
                return Err(e);
            }

            tracing::info!("Successfully synced {} chunks to BM25", chunks.len());
        } else {
            tracing::warn!("BM25 index not available, skipping sync");
        }
        Ok(())
    }
}

enum ProcessResult {
    Indexed,
    Skipped,
}

/// Scan a directory for supported files
fn scan_directory(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();

    for entry in WalkDir::new(dir).into_iter().filter_entry(|e| {
        // Skip hidden files/dirs
        !e.file_name().to_string_lossy().starts_with('.')
    }) {
        let entry = entry.context("Failed to read directory entry")?;
        if entry.file_type().is_file() {
            let ext = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            if is_supported_extension(ext) {
                files.push(entry.path().to_path_buf());
            }
        }
    }

    Ok(files)
}

fn is_supported_extension(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "md" | "txt" | "rs" | "ts" | "tsx" | "py" | "go"
    )
}

fn file_extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("txt")
        .to_lowercase()
}

fn compute_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}
