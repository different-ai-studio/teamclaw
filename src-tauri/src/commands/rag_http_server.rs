use axum::{
    extract::State as AxumState, http::StatusCode, routing::get, routing::post, Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use super::knowledge::RagState;
use teamclaw_rag::hybrid_search::SearchMode;
use teamclaw_rag::search;

pub struct AppState {
    pub rag_state: Arc<RagState>,
}

#[derive(Deserialize)]
struct SearchRequest {
    query: String,
    top_k: Option<usize>,
    search_mode: Option<String>,
    min_score: Option<f64>,
}

#[derive(Deserialize)]
struct IndexRequest {
    path: Option<String>,
    force: Option<bool>,
}

#[derive(Deserialize)]
struct ListRequest {}

#[derive(Deserialize)]
struct MemorySaveRequest {
    filename: String,
    content: String,
}

#[derive(Deserialize)]
struct MemoryDeleteRequest {
    filename: String,
}

pub async fn start_http_server(rag_state: Arc<RagState>, port: u16) -> anyhow::Result<()> {
    let app_state = Arc::new(AppState {
        rag_state: rag_state.clone(),
    });

    let app = Router::new()
        .route("/api/rag/search", post(handle_search))
        .route("/api/rag/index", post(handle_index))
        .route("/api/rag/list", post(handle_list))
        .route("/api/rag/memory/list", post(handle_memory_list))
        .route("/api/rag/memory/save", post(handle_memory_save))
        .route("/api/rag/memory/delete", post(handle_memory_delete))
        .route("/api/rag/workspaces", get(handle_workspaces))
        .route("/api/rag/current-workspace", get(handle_current_workspace))
        .route("/health", get(|| async { "OK" }))
        .layer(CorsLayer::permissive())
        .with_state(app_state);

    let listener = TcpListener::bind(format!("127.0.0.1:{}", port)).await?;
    let addr = listener.local_addr()?;
    tracing::info!("RAG HTTP API listening on http://{}", addr);

    axum::serve(listener, app).await?;
    Ok(())
}

async fn handle_search(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(req): Json<SearchRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Get current workspace (must be set by frontend first)
    let workspace_path = state
        .rag_state
        .get_current_workspace()
        .await
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "No workspace set. Please open a workspace in TeamClaw first.".to_string(),
            )
        })?;

    let instance = state
        .rag_state
        .get_or_create_instance(&workspace_path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let instance = instance.lock().await;

    let mode = SearchMode::parse_or_hybrid(req.search_mode.as_deref().unwrap_or("hybrid"));
    let top_k = req.top_k.unwrap_or(5);

    match search::search(
        &instance.db,
        &instance.embedding,
        instance.bm25_index.as_ref(),
        &instance.config,
        search::SearchParams {
            query: &req.query,
            top_k,
            mode,
            min_score: req.min_score,
        },
    )
    .await
    {
        Ok(result) => Ok(Json(serde_json::to_value(result).unwrap())),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

async fn handle_index(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(req): Json<IndexRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Get current workspace (must be set by frontend first)
    let workspace_path = state
        .rag_state
        .get_current_workspace()
        .await
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "No workspace set. Please open a workspace in TeamClaw first.".to_string(),
            )
        })?;

    let instance = state
        .rag_state
        .get_or_create_instance(&workspace_path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let instance = instance.lock().await;

    let result = if req.force.unwrap_or(false) && req.path.is_none() {
        instance.indexer.force_reindex_all().await
    } else {
        instance.indexer.index_directory(req.path.as_deref()).await
    };

    match result {
        Ok(result) => Ok(Json(serde_json::to_value(result).unwrap())),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

async fn handle_list(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(_req): Json<ListRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Get current workspace (must be set by frontend first)
    let workspace_path = state
        .rag_state
        .get_current_workspace()
        .await
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "No workspace set. Please open a workspace in TeamClaw first.".to_string(),
            )
        })?;

    let instance = state
        .rag_state
        .get_or_create_instance(&workspace_path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let instance = instance.lock().await;

    match instance.db.list_documents().await {
        Ok(docs) => {
            let total_chunks = instance.db.get_total_chunk_count().await.unwrap_or(0);
            let response = serde_json::json!({
                "documents": docs,
                "total_documents": docs.len(),
                "total_chunks": total_chunks,
            });
            Ok(Json(response))
        }
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

async fn handle_workspaces(
    AxumState(state): AxumState<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let workspace = state.rag_state.get_current_workspace().await;
    let workspaces = if let Some(ref ws) = workspace {
        vec![ws.clone()]
    } else {
        vec![]
    };
    Ok(Json(serde_json::json!({
        "workspaces": workspaces,
    })))
}

async fn handle_current_workspace(
    AxumState(state): AxumState<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let workspace = state.rag_state.get_current_workspace().await;
    Ok(Json(serde_json::json!({
        "current_workspace": workspace,
    })))
}

// ============================================================================
// Memory HTTP Handlers
// ============================================================================

async fn handle_memory_list(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(_req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let workspace_path = state
        .rag_state
        .get_current_workspace()
        .await
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "No workspace set.".to_string()))?;

    let memory_dir = std::path::PathBuf::from(&workspace_path).join("knowledge/memory");
    if !memory_dir.exists() {
        return Ok(Json(serde_json::json!({ "memories": [], "total": 0 })));
    }

    let mut memories = Vec::new();
    let entries = std::fs::read_dir(&memory_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let filename = path.file_name().unwrap().to_string_lossy().to_string();
            if let Ok(raw) = std::fs::read_to_string(&path) {
                let record = super::knowledge::parse_memory_file(&filename, &raw);
                memories.push(serde_json::to_value(record).unwrap());
            }
        }
    }

    let total = memories.len();
    Ok(Json(
        serde_json::json!({ "memories": memories, "total": total }),
    ))
}

async fn handle_memory_save(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(req): Json<MemorySaveRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let workspace_path = state
        .rag_state
        .get_current_workspace()
        .await
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "No workspace set.".to_string()))?;

    let memory_dir = std::path::PathBuf::from(&workspace_path).join("knowledge/memory");
    std::fs::create_dir_all(&memory_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let safe_filename = if req.filename.ends_with(".md") {
        req.filename
    } else {
        format!("{}.md", req.filename)
    };
    let file_path = memory_dir.join(&safe_filename);

    std::fs::write(&file_path, &req.content)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Trigger incremental indexing
    let rel_path = format!("knowledge/memory/{}", safe_filename);
    let instance = state
        .rag_state
        .get_or_create_instance(&workspace_path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let instance = instance.lock().await;
    let _ = instance.indexer.index_directory(Some(&rel_path)).await;

    Ok(Json(
        serde_json::json!({ "success": true, "filename": safe_filename }),
    ))
}

async fn handle_memory_delete(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(req): Json<MemoryDeleteRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let workspace_path = state
        .rag_state
        .get_current_workspace()
        .await
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "No workspace set.".to_string()))?;

    let memory_dir = std::path::PathBuf::from(&workspace_path).join("knowledge/memory");
    let file_path = memory_dir.join(&req.filename);

    if file_path.exists() {
        std::fs::remove_file(&file_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    // Remove from index
    let rel_path = format!("knowledge/memory/{}", req.filename);
    let instance = state
        .rag_state
        .get_or_create_instance(&workspace_path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
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

    Ok(Json(serde_json::json!({ "success": true })))
}
