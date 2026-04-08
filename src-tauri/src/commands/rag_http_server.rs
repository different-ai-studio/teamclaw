use axum::{
    extract::State as AxumState, http::StatusCode, routing::get, routing::post, Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use super::knowledge::RagState;
use crate::rag::hybrid_search::SearchMode;
use crate::rag::search;

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
        .route("/device-token-test", get(handle_device_token_test))
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

    let mode = SearchMode::from_str(req.search_mode.as_deref().unwrap_or("hybrid"));
    let top_k = req.top_k.unwrap_or(5);

    match search::search(
        &instance.db,
        &instance.embedding,
        instance.bm25_index.as_ref(),
        &instance.config,
        &req.query,
        top_k,
        mode,
        req.min_score,
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

/// GET /device-token-test
///
/// A self-contained test page that reads `window.teamclaw.deviceToken` from the
/// webview initialization script and displays it.  Open this URL inside a
/// Teamclaw webview tab: http://127.0.0.1:13143/device-token-test
async fn handle_device_token_test() -> axum::response::Response {
    // Generate a server-side reference token so the page is useful even when
    // window.teamclaw is not yet injected (e.g. first load before rebuild).
    let server_token = match super::oss_commands::get_or_create_fallback_device_id() {
        Ok(device_id) => super::device_token::generate(&device_id, "")
            .unwrap_or_else(|e| format!("ERROR: {}", e)),
        Err(e) => format!("ERROR: {}", e),
    };

    // Escape the server token for safe embedding inside a JS string literal.
    let server_token_js = server_token.replace('\\', "\\\\").replace('"', "\\\"");

    let html = format!(r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Device Token Test</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #0f1117; color: #e2e8f0; min-height: 100vh;
           display: flex; flex-direction: column; align-items: center;
           justify-content: flex-start; padding: 40px 24px; }}
    h1   {{ font-size: 1.4rem; font-weight: 700; color: #7ee787; margin-bottom: 24px; }}
    h2   {{ font-size: 0.95rem; font-weight: 600; color: #a0aec0; margin: 24px 0 12px; }}
    .card {{ background: #1a1f2e; border: 1px solid #2d3748; border-radius: 12px;
            padding: 24px; width: 100%; max-width: 820px; margin-bottom: 20px; }}
    .label {{ font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
             letter-spacing: .08em; color: #718096; margin-bottom: 6px; }}
    .value {{ font-family: "SF Mono", "Fira Code", monospace; font-size: 0.80rem;
             color: #e2e8f0; word-break: break-all; background: #0d1117;
             border-radius: 6px; padding: 10px 14px; }}
    .value.ok   {{ border-left: 3px solid #7ee787; color: #7ee787; }}
    .value.warn {{ border-left: 3px solid #f6c90e; color: #f6c90e; }}
    .value.err  {{ border-left: 3px solid #fc8181; color: #fc8181; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 0.82rem; }}
    td    {{ padding: 7px 10px; border-bottom: 1px solid #2d3748; vertical-align: top; }}
    td:first-child {{ color: #718096; width: 130px; white-space: nowrap; }}
    td:last-child  {{ font-family: "SF Mono", "Fira Code", monospace; word-break: break-all; }}
    .btn {{ margin-top: 14px; padding: 7px 18px; background: #2d3748;
            border: 1px solid #4a5568; border-radius: 8px; color: #e2e8f0;
            font-size: 0.83rem; cursor: pointer; margin-right: 8px; }}
    .btn:hover {{ background: #3d4f63; }}
    #status {{ font-size: 0.78rem; color: #718096; margin-top: 8px; min-height: 1.2em; }}
    .tag {{ display: inline-block; font-size: 0.68rem; padding: 2px 7px;
            border-radius: 4px; font-weight: 600; margin-left: 8px; vertical-align: middle; }}
    .tag-webview {{ background:#1a3a1a; color:#7ee787; }}
    .tag-server  {{ background:#1a2040; color:#7eb8f7; }}
  </style>
</head>
<body>
  <h1>&#x1F511; Device Token Test</h1>

  <!-- ── Section 1: window.teamclaw (injected by Tauri webview) ── -->
  <div class="card">
    <div class="label">window.teamclaw presence <span class="tag tag-webview">webview</span></div>
    <div id="tc-presence" class="value">checking…</div>
  </div>

  <div class="card">
    <div class="label">device_token from window.teamclaw <span class="tag tag-webview">webview</span></div>
    <div id="tc-token" class="value">—</div>
    <button class="btn" onclick="copyTok('tc-token')">Copy</button>
    <button class="btn" onclick="alertTok('tc-token')">Alert</button>
    <div id="status-tc"></div>
  </div>

  <div class="card">
    <div class="label">JWT claims (webview token decoded) <span class="tag tag-webview">webview</span></div>
    <table id="tc-claims"><tr><td colspan="2" style="color:#718096">—</td></tr></table>
  </div>

  <div class="card">
    <div class="label">window.teamclaw — all fields <span class="tag tag-webview">webview</span></div>
    <table id="tc-fields"><tr><td colspan="2" style="color:#718096">—</td></tr></table>
  </div>

  <!-- ── Section 2: server-generated reference token ── -->
  <div class="card">
    <div class="label">server-generated reference token <span class="tag tag-server">server-side</span></div>
    <div class="value ok" id="srv-token">{server_token}</div>
    <button class="btn" onclick="copyTok('srv-token')">Copy</button>
    <button class="btn" onclick="alertTok('srv-token')">Alert</button>
    <div id="status-srv"></div>
  </div>

  <div class="card">
    <div class="label">JWT claims (server token decoded) <span class="tag tag-server">server-side</span></div>
    <table id="srv-claims"><tr><td colspan="2" style="color:#718096">loading…</td></tr></table>
  </div>

  <script>
    const SERVER_TOKEN = "{server_token_js}";

    function b64url(s) {{
      try {{ return JSON.parse(atob(s.replace(/-/g,'+').replace(/_/g,'/'))); }}
      catch {{ return null; }}
    }}

    function renderTable(id, obj) {{
      const t = document.getElementById(id);
      if (!obj) {{ t.innerHTML = '<tr><td colspan="2" style="color:#fc8181">parse error</td></tr>'; return; }}
      t.innerHTML = Object.entries(obj).map(([k,v]) => {{
        let val = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if ((k==='iat'||k==='exp') && typeof v === 'number')
          val = v + ' (' + new Date(v*1000).toISOString() + ')';
        return '<tr><td>'+k+'</td><td>'+val+'</td></tr>';
      }}).join('');
    }}

    function decodeAndRender(token, tableId) {{
      const parts = token.split('.');
      if (parts.length !== 3) return;
      const claims = b64url(parts[1]);
      renderTable(tableId, claims);
    }}

    function copyTok(elId) {{
      const tok = document.getElementById(elId).textContent.trim();
      navigator.clipboard.writeText(tok).then(() => {{
        const sid = elId.startsWith('srv') ? 'status-srv' : 'status-tc';
        document.getElementById(sid).textContent = '✅ copied';
        setTimeout(() => {{ document.getElementById(sid).textContent = ''; }}, 2000);
      }});
    }}

    function alertTok(elId) {{
      alert(document.getElementById(elId).textContent.trim());
    }}

    // ── Decode server token immediately ──
    decodeAndRender(SERVER_TOKEN, 'srv-claims');

    // ── Inspect window.teamclaw (injected by Tauri) ──
    (function checkWebview() {{
      const tc = window.teamclaw;
      const presEl  = document.getElementById('tc-presence');
      const tokenEl = document.getElementById('tc-token');

      if (!tc) {{
        presEl.textContent = 'NOT present — app needs to be rebuilt so get_persistent_device_id is registered';
        presEl.className = 'value warn';
        return;
      }}

      presEl.textContent = 'present ✓';
      presEl.className = 'value ok';
      renderTable('tc-fields', tc);

      const token = tc.deviceToken;
      if (!token) {{
        tokenEl.textContent = '(empty)';
        tokenEl.className = 'value err';
        return;
      }}

      tokenEl.textContent = token;
      tokenEl.className = 'value ok';
      decodeAndRender(token, 'tc-claims');
      alert('window.teamclaw.deviceToken:\n\n' + token);
    }})();
  </script>
</body>
</html>"#,
        server_token = server_token,
        server_token_js = server_token_js,
    );

    axum::response::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .body(axum::body::Body::from(html))
        .unwrap()
}
