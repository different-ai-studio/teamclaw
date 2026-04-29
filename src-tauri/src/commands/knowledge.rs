use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

use teamclaw_rag::{
    bm25::BM25Index, config::RagConfig, db::DocumentRecord, embedding, indexer::Indexer,
    search::SearchResponse, watcher::KnowledgeWatcher, Database, IndexResult,
};

// ============================================================================
// State Management
// ============================================================================

pub struct RagInstance {
    pub db: Database,
    pub embedding: Arc<dyn embedding::EmbeddingProvider>,
    pub bm25_index: Option<BM25Index>,
    pub indexer: Arc<Indexer>,
    pub watcher: Option<Arc<KnowledgeWatcher>>,
    pub config: RagConfig,
}

#[derive(Default, Clone)]
pub struct RagState {
    current_workspace: Arc<Mutex<Option<String>>>,
    current_instance: Arc<Mutex<Option<Arc<Mutex<RagInstance>>>>>,
}

impl RagState {
    /// Get current workspace path
    pub async fn get_current_workspace(&self) -> Option<String> {
        let workspace = self.current_workspace.lock().await;
        workspace.clone()
    }

    /// Get or create instance for the current workspace
    pub async fn get_or_create_instance(
        &self,
        workspace_path: &str,
    ) -> Result<Arc<Mutex<RagInstance>>, String> {
        let mut current_workspace = self.current_workspace.lock().await;
        let mut current_instance = self.current_instance.lock().await;

        // If workspace changed, clear old instance
        if current_workspace.as_ref() != Some(&workspace_path.to_string()) {
            tracing::info!(
                "[RAG] Workspace changed: {:?} -> {}",
                *current_workspace,
                workspace_path
            );
            *current_workspace = Some(workspace_path.to_string());
            *current_instance = None;
        }

        // Return existing instance if available
        if let Some(instance) = current_instance.as_ref() {
            return Ok(instance.clone());
        }

        // Create new instance
        tracing::info!("[RAG] Creating instance for workspace: {}", workspace_path);
        let workspace_path_buf = PathBuf::from(workspace_path);
        let config = RagConfig::load_from_workspace(&workspace_path_buf, super::TEAMCLAW_DIR)
            .await
            .map_err(|e| format!("Failed to load config: {}", e))?;

        let db_path = config.db_path(&workspace_path_buf, super::TEAMCLAW_DIR);
        let db = Database::new(&db_path)
            .await
            .map_err(|e| format!("Failed to create database: {}", e))?;
        db.migrate()
            .await
            .map_err(|e| format!("Failed to migrate database: {}", e))?;

        let embedding_provider = embedding::create_provider(&config)
            .map_err(|e| format!("Failed to create embedding provider: {}", e))?;

        let bm25_index_path = config.bm25_index_path(&workspace_path_buf, super::TEAMCLAW_DIR);
        let bm25_index = BM25Index::new(&bm25_index_path).ok();
        if bm25_index.is_none() {
            eprintln!("Warning: Failed to initialize BM25 index");
        }

        let indexer = Arc::new(Indexer::new(
            db.clone(),
            embedding_provider.clone(),
            bm25_index.clone(),
            config.clone(),
            workspace_path_buf.clone(),
        ));

        let instance = Arc::new(Mutex::new(RagInstance {
            db,
            embedding: embedding_provider,
            bm25_index,
            indexer,
            watcher: None,
            config,
        }));

        *current_instance = Some(instance.clone());
        Ok(instance)
    }

    /// Clear current instance (useful when force reindex)
    pub async fn clear_current_instance(&self) {
        let mut current_instance = self.current_instance.lock().await;
        *current_instance = None;
    }
}

// ============================================================================
// Index Commands
// ============================================================================

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub total_documents: usize,
    pub total_chunks: i64,
    pub last_indexed: Option<String>,
    pub bm25_documents: u64,
}

#[tauri::command]
pub async fn rag_index(
    workspace_path: String,
    path: Option<String>,
    force: Option<bool>,
    state: State<'_, RagState>,
) -> Result<IndexResult, String> {
    if force.unwrap_or(false) && path.is_none() {
        // Force reindex: delete BM25 index directory and recreate instance
        let workspace_path_buf = PathBuf::from(&workspace_path);
        let config = RagConfig::load_from_workspace(&workspace_path_buf, super::TEAMCLAW_DIR)
            .await
            .map_err(|e| format!("Failed to load config: {}", e))?;

        let bm25_path = config.bm25_index_path(&workspace_path_buf, super::TEAMCLAW_DIR);
        if bm25_path.exists() {
            if let Err(e) = std::fs::remove_dir_all(&bm25_path) {
                eprintln!("Warning: Failed to remove old BM25 index: {}", e);
            } else {
                eprintln!("Old BM25 index removed, will be recreated");
            }
        }

        // Clear current instance so it recreates with fresh BM25 index
        state.clear_current_instance().await;

        // Get fresh instance with new BM25 index
        let instance = state.get_or_create_instance(&workspace_path).await?;
        let instance = instance.lock().await;

        instance
            .indexer
            .force_reindex_all()
            .await
            .map_err(|e| format!("Force reindexing failed: {}", e))
    } else {
        // Normal incremental indexing
        let instance = state.get_or_create_instance(&workspace_path).await?;
        let instance = instance.lock().await;

        instance
            .indexer
            .index_directory(path.as_deref())
            .await
            .map_err(|e| format!("Indexing failed: {}", e))
    }
}

#[tauri::command]
pub async fn rag_get_index_status(
    workspace_path: String,
    state: State<'_, RagState>,
) -> Result<IndexStatus, String> {
    let instance = state.get_or_create_instance(&workspace_path).await?;
    let instance = instance.lock().await;

    let documents = instance
        .db
        .list_documents()
        .await
        .map_err(|e| format!("Failed to list documents: {}", e))?;
    let total_chunks = instance
        .db
        .get_total_chunk_count()
        .await
        .map_err(|e| format!("Failed to get chunk count: {}", e))?;

    let last_indexed = documents
        .iter()
        .map(|d| d.indexed_at.as_str())
        .max()
        .map(|s| s.to_string());

    let bm25_documents = if let Some(bm25) = &instance.bm25_index {
        bm25.num_docs().await
    } else {
        0
    };

    Ok(IndexStatus {
        total_documents: documents.len(),
        total_chunks,
        last_indexed,
        bm25_documents,
    })
}

// ============================================================================
// Search Commands
// ============================================================================

#[tauri::command]
pub async fn rag_search(
    workspace_path: String,
    query: String,
    top_k: Option<usize>,
    search_mode: Option<String>,
    min_score: Option<f64>,
    state: State<'_, RagState>,
) -> Result<SearchResponse, String> {
    let instance = state.get_or_create_instance(&workspace_path).await?;
    let instance = instance.lock().await;

    let top_k = top_k.unwrap_or(5);
    let mode = teamclaw_rag::hybrid_search::SearchMode::parse_or_hybrid(
        search_mode.as_deref().unwrap_or("hybrid"),
    );

    teamclaw_rag::search::search(
        &instance.db,
        &instance.embedding,
        instance.bm25_index.as_ref(),
        &instance.config,
        teamclaw_rag::search::SearchParams {
            query: &query,
            top_k,
            mode,
            min_score,
        },
    )
    .await
    .map_err(|e| format!("Search failed: {}", e))
}

// ============================================================================
// Document Management Commands
// ============================================================================

#[tauri::command]
pub async fn rag_list_documents(
    workspace_path: String,
    state: State<'_, RagState>,
) -> Result<Vec<DocumentRecord>, String> {
    let instance = state.get_or_create_instance(&workspace_path).await?;
    let instance = instance.lock().await;

    instance
        .db
        .list_documents()
        .await
        .map_err(|e| format!("Failed to list documents: {}", e))
}

#[tauri::command]
pub async fn rag_delete_document(
    workspace_path: String,
    path: String,
    state: State<'_, RagState>,
) -> Result<(), String> {
    let instance = state.get_or_create_instance(&workspace_path).await?;
    let instance = instance.lock().await;

    if let Some(doc) = instance
        .db
        .get_document_by_path(&path)
        .await
        .map_err(|e| format!("Failed to get document: {}", e))?
    {
        instance
            .db
            .delete_document(doc.id)
            .await
            .map_err(|e| format!("Failed to delete document: {}", e))?;
    }

    Ok(())
}

// ============================================================================
// Config Commands
// ============================================================================

#[tauri::command]
pub async fn rag_get_config(
    workspace_path: String,
    state: State<'_, RagState>,
) -> Result<RagConfig, String> {
    let instance = state.get_or_create_instance(&workspace_path).await?;
    let instance = instance.lock().await;
    Ok(instance.config.clone())
}

#[tauri::command]
pub async fn rag_save_config(
    workspace_path: String,
    config: RagConfig,
    state: State<'_, RagState>,
) -> Result<(), String> {
    let workspace_path_buf = PathBuf::from(&workspace_path);
    config
        .save_to_workspace(&workspace_path_buf, super::TEAMCLAW_DIR)
        .await
        .map_err(|e| format!("Failed to save config: {}", e))?;

    // Clear current instance so it reloads with new config
    state.clear_current_instance().await;

    Ok(())
}

// ============================================================================
// File Watcher Commands
// ============================================================================

#[tauri::command]
pub async fn rag_start_watcher(
    app: tauri::AppHandle,
    workspace_path: String,
    state: State<'_, RagState>,
) -> Result<(), String> {
    let instance = state.get_or_create_instance(&workspace_path).await?;
    let mut instance = instance.lock().await;

    if instance.watcher.is_some() {
        return Ok(()); // Already running
    }

    let knowledge_dirs = instance
        .config
        .knowledge_dirs(&PathBuf::from(&workspace_path));
    let app_clone = app.clone();
    let watcher = KnowledgeWatcher::watch(
        knowledge_dirs,
        instance.indexer.clone(),
        Some(Box::new(move || {
            use tauri::Emitter;
            let _ = app_clone.emit("knowledge-index-changed", ());
        })),
    )
    .map_err(|e| format!("Failed to start file watcher: {}", e))?;

    instance.watcher = Some(Arc::new(watcher));
    Ok(())
}

#[tauri::command]
pub async fn rag_stop_watcher(
    workspace_path: String,
    state: State<'_, RagState>,
) -> Result<(), String> {
    let instance = state.get_or_create_instance(&workspace_path).await?;
    let mut instance = instance.lock().await;
    instance.watcher = None;
    Ok(())
}

// ============================================================================
// Memory Commands
// ============================================================================

#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub filename: String,
    pub title: String,
    pub category: String,
    pub tags: Vec<String>,
    pub created: String,
    pub updated: String,
    pub content: String,
}

pub fn parse_memory_file(filename: &str, raw: &str) -> MemoryRecord {
    let mut title = String::new();
    let mut category = String::new();
    let mut tags: Vec<String> = Vec::new();
    let mut created = String::new();
    let mut updated = String::new();
    let content;

    let trimmed = raw.trim();
    if trimmed.starts_with("---") {
        if let Some(end) = trimmed[3..].find("---") {
            let frontmatter = &trimmed[3..3 + end];
            content = trimmed[3 + end + 3..].trim().to_string();

            for line in frontmatter.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("title:") {
                    title = val.trim().trim_matches('"').to_string();
                } else if let Some(val) = line.strip_prefix("category:") {
                    category = val.trim().trim_matches('"').to_string();
                } else if let Some(val) = line.strip_prefix("created:") {
                    created = val.trim().trim_matches('"').to_string();
                } else if let Some(val) = line.strip_prefix("updated:") {
                    updated = val.trim().trim_matches('"').to_string();
                } else if let Some(val) = line.strip_prefix("tags:") {
                    let val = val.trim();
                    if val.starts_with('[') && val.ends_with(']') {
                        tags = val[1..val.len() - 1]
                            .split(',')
                            .map(|t| t.trim().trim_matches('"').to_string())
                            .filter(|t| !t.is_empty())
                            .collect();
                    }
                }
            }
        } else {
            content = raw.to_string();
        }
    } else {
        content = raw.to_string();
    }

    if title.is_empty() {
        title = filename.trim_end_matches(".md").replace('-', " ");
    }

    MemoryRecord {
        filename: filename.to_string(),
        title,
        category,
        tags,
        created,
        updated,
        content,
    }
}

#[tauri::command]
#[allow(dead_code)]
pub async fn rag_list_memories(workspace_path: String) -> Result<Vec<MemoryRecord>, String> {
    let memory_dir = PathBuf::from(&workspace_path).join("knowledge/memory");

    if !memory_dir.exists() {
        return Ok(Vec::new());
    }

    let mut memories = Vec::new();
    let entries =
        fs::read_dir(&memory_dir).map_err(|e| format!("Failed to read memory directory: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let filename = path.file_name().unwrap().to_string_lossy().to_string();
            match fs::read_to_string(&path) {
                Ok(raw) => memories.push(parse_memory_file(&filename, &raw)),
                Err(e) => eprintln!("Failed to read memory file {:?}: {}", path, e),
            }
        }
    }

    memories.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(memories)
}

#[tauri::command]
#[allow(dead_code)]
pub async fn rag_save_memory(
    workspace_path: String,
    filename: String,
    content: String,
    state: State<'_, RagState>,
) -> Result<(), String> {
    let memory_dir = PathBuf::from(&workspace_path).join("knowledge/memory");

    fs::create_dir_all(&memory_dir)
        .map_err(|e| format!("Failed to create memory directory: {}", e))?;

    let safe_filename = if filename.ends_with(".md") {
        filename
    } else {
        format!("{}.md", filename)
    };
    let file_path = memory_dir.join(&safe_filename);

    fs::write(&file_path, &content).map_err(|e| format!("Failed to write memory file: {}", e))?;

    // Trigger incremental indexing for the memory file
    let rel_path = format!("knowledge/memory/{}", safe_filename);
    let _ = trigger_memory_index(&workspace_path, &rel_path, &state).await;

    Ok(())
}

#[tauri::command]
#[allow(dead_code)]
pub async fn rag_delete_memory(
    workspace_path: String,
    filename: String,
    state: State<'_, RagState>,
) -> Result<(), String> {
    let memory_dir = PathBuf::from(&workspace_path).join("knowledge/memory");
    let file_path = memory_dir.join(&filename);

    if file_path.exists() {
        fs::remove_file(&file_path).map_err(|e| format!("Failed to delete memory file: {}", e))?;
    }

    // Remove from index
    let rel_path = format!("knowledge/memory/{}", filename);
    let instance = state.get_or_create_instance(&workspace_path).await?;
    let instance = instance.lock().await;
    if let Some(doc) = instance
        .db
        .get_document_by_path(&rel_path)
        .await
        .ok()
        .flatten()
    {
        let _ = instance.db.delete_document(doc.id).await;
    }

    Ok(())
}

#[allow(dead_code)]
async fn trigger_memory_index(
    workspace_path: &str,
    rel_path: &str,
    state: &State<'_, RagState>,
) -> Result<(), String> {
    let instance = state.get_or_create_instance(workspace_path).await?;
    let instance = instance.lock().await;
    let _ = instance.indexer.index_directory(Some(rel_path)).await;
    Ok(())
}

// ============================================================================
// Legacy Document Conversion Commands
// ============================================================================

#[tauri::command]
pub async fn convert_to_markdown(file_path: String, output_path: String) -> Result<String, String> {
    let md = markitdown::MarkItDown::new();

    let extension = Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e));

    let options = markitdown::model::ConversionOptions {
        file_extension: extension,
        url: None,
        llm_client: None,
        llm_model: None,
    };

    let result = md.convert(&file_path, Some(options)).ok_or_else(|| {
        format!(
            "Conversion failed: unsupported file type or conversion error for {}",
            file_path
        )
    })?;

    fs::write(&output_path, &result.text_content)
        .map_err(|e| format!("Failed to write output: {}", e))?;

    Ok(output_path)
}

#[tauri::command]
pub async fn batch_convert_to_markdown(
    file_paths: Vec<String>,
    output_dir: String,
) -> Result<Vec<(String, Result<String, String>)>, String> {
    let mut results = Vec::new();

    if let Err(e) = fs::create_dir_all(&output_dir) {
        return Err(format!("Failed to create output directory: {}", e));
    }

    for file_path in file_paths {
        let filename = Path::new(&file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("converted");

        let output_path = format!("{}/{}.md", output_dir, filename);
        let result = convert_to_markdown(file_path.clone(), output_path.clone()).await;

        results.push((file_path, result));
    }

    Ok(results)
}
