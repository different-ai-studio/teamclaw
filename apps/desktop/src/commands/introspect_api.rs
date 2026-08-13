// Internal HTTP API server for the teamclu-introspect MCP binary.
//
// Listens on 127.0.0.1:13144 and handles:
//   POST /send-wecom        — send a proactive WeCom message
//   POST /cron-run          — manually trigger a cron job
//   POST /team-sync-all     — trigger team sync
//   POST /knowledge-search  — semantic search in knowledge base
//   POST /knowledge-add     — save a memory entry
//   POST /knowledge-list    — list memory entries
//   POST /knowledge-delete  — delete a memory entry
//   POST /env-var-set       — create or update an env var (`scope`: personal | team)
//   POST /env-var-delete    — delete an env var (`scope`: personal | team)
//   POST /mcp-get           — fetch merged workspace MCP map (daemon)
//   POST /mcp-put           — replace workspace MCP map (daemon)
//   POST /session-archive   — archive a cloud session (PATCH archivedAt)
//   POST /session-export    — export session messages as opencode-compatible JSON
//
// Uses raw TCP + manual HTTP parsing to stay minimal (no axum state needed).

pub const INTROSPECT_API_PORT: u16 = 13144;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub async fn start_introspect_api(app: AppHandle) -> anyhow::Result<()> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", INTROSPECT_API_PORT)).await?;
    println!(
        "[IntrospectAPI] Listening on 127.0.0.1:{}",
        INTROSPECT_API_PORT
    );

    loop {
        let (mut stream, _peer) = listener.accept().await?;
        let app_clone = app.clone();

        tokio::spawn(async move {
            // Read initial chunk (headers + maybe partial body)
            let mut buf = vec![0u8; 65536];
            let n = match stream.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };

            // Parse headers
            let header_end = match find_double_crlf(&buf[..n]) {
                Some(i) => i,
                None => {
                    let _ = write_response(&mut stream, 400, "Bad Request").await;
                    return;
                }
            };

            let header_str = match std::str::from_utf8(&buf[..header_end]) {
                Ok(s) => s,
                Err(_) => {
                    let _ = write_response(&mut stream, 400, "Bad Request").await;
                    return;
                }
            };

            let first_line = header_str.lines().next().unwrap_or("");
            let mut parts = first_line.splitn(3, ' ');
            let method = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("");

            // Parse Content-Length for large bodies (e.g. image base64)
            let content_length: usize = header_str
                .lines()
                .find_map(|line| {
                    let lower = line.to_ascii_lowercase();
                    lower
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse().ok())
                })
                .unwrap_or(0);

            // Read remaining body if needed
            let body_start = header_end + 4;
            let mut body_buf: Vec<u8> = buf[body_start..n].to_vec();
            while body_buf.len() < content_length {
                let mut chunk = vec![0u8; 65536];
                match stream.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(cn) => body_buf.extend_from_slice(&chunk[..cn]),
                    Err(_) => break,
                }
            }
            let body_bytes = &body_buf[..];

            let resp = match (method, path) {
                ("POST", "/send-wecom") => handle_send_wecom(&app_clone, body_bytes).await,
                ("POST", "/cron-run") => handle_cron_run(&app_clone, body_bytes).await,
                ("POST", "/team-sync-all") => handle_team_sync_all(&app_clone, body_bytes).await,
                ("POST", "/knowledge-search") => {
                    handle_knowledge_search(&app_clone, body_bytes).await
                }
                ("POST", "/knowledge-add") => handle_knowledge_add(&app_clone, body_bytes).await,
                ("POST", "/knowledge-list") => handle_knowledge_list(&app_clone, body_bytes).await,
                ("POST", "/knowledge-delete") => {
                    handle_knowledge_delete(&app_clone, body_bytes).await
                }
                ("POST", "/env-var-set") => handle_env_var_set(&app_clone, body_bytes).await,
                ("POST", "/env-var-delete") => handle_env_var_delete(&app_clone, body_bytes).await,
                ("POST", "/session-export") => handle_session_export(&app_clone, body_bytes).await,
                ("POST", "/channel-set") => handle_channel_set(&app_clone, body_bytes).await,
                ("POST", "/mcp-get") => handle_mcp_get(&app_clone, body_bytes).await,
                ("POST", "/mcp-put") => handle_mcp_put(&app_clone, body_bytes).await,
                ("POST", "/session-archive") => {
                    handle_session_archive(&app_clone, body_bytes).await
                }
                ("POST", "/git-credential-get") => {
                    handle_git_credential_get(&app_clone, body_bytes).await
                }
                _ => Err(format!("Not found: {} {}", method, path)),
            };

            let (status, body) = match resp {
                Ok(msg) => (200u16, msg),
                Err(e) => (500u16, e),
            };
            let _ = write_response(&mut stream, status, &body).await;
        });
    }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async fn handle_send_wecom(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    use base64::Engine as _;

    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let target = v.get("target").and_then(|v| v.as_str()).unwrap_or("");
    let message = v.get("message").and_then(|v| v.as_str()).unwrap_or("");

    // If target is empty, fallback to ownerId from config
    let resolved_target: String;
    let target = if target.is_empty() {
        resolved_target = resolve_wecom_owner_id(app)?;
        &resolved_target
    } else {
        target
    };

    // Parse target format: "single:{userid}" or "group:{chatid}" or bare chatid
    let (chatid, chat_type) = if let Some(userid) = target.strip_prefix("single:") {
        (userid, 1u32)
    } else if let Some(chatid) = target.strip_prefix("group:") {
        (chatid, 2u32)
    } else {
        // Treat bare value as single user (chat_type=1)
        (target, 1u32)
    };

    // Send text message if provided
    if !message.is_empty() {
        teamclu_gateway::wecom::send_proactive_message(chatid, chat_type, message).await?;
    }

    // Send media file if provided (image/voice/video/file)
    let media_sent = if let Some(b64) = v.get("media_base64").and_then(|v| v.as_str()) {
        let data = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Invalid media base64: {}", e))?;
        let filename = v
            .get("media_filename")
            .and_then(|v| v.as_str())
            .unwrap_or("file");
        let media_type = v
            .get("media_type")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| detect_media_type(filename));

        teamclu_gateway::wecom::upload_and_send_media(
            chatid, chat_type, &data, filename, media_type,
        )
        .await?;
        true
    } else {
        false
    };

    Ok(format!(
        r#"{{"ok":true,"chatid":"{}","chat_type":{},"media_sent":{}}}"#,
        chatid, chat_type, media_sent
    ))
}

async fn handle_team_sync_all(app: &AppHandle, _body: &[u8]) -> Result<String, String> {
    // introspect_api has no calling-window context (HTTP server). Falls back
    // to current_workspace in WindowRegistry.
    let registry = app.state::<super::window::WindowRegistry>();
    let workspace = registry
        .current_workspace
        .lock()
        .ok()
        .and_then(|cw| cw.clone())
        .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?;
    // Plan B Task 8: the desktop sync engine is gone — the daemon owns team
    // sync now. Forward to the daemon's team-sync endpoint for the workspace.
    let result = super::team_sync_proxy::daemon_team_sync(&workspace, false, true).await?;
    serde_json::to_string(&result).map_err(|e| format!("Serialization error: {e}"))
}

async fn handle_cron_run(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let job_id = v
        .get("job_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: job_id")?;

    // introspect_api has no calling-window context (it's an HTTP server).
    // The request payload may carry an explicit workspace_path; otherwise we
    // fall back to single-instance inference (which errors in multi-window).
    let workspace_path = match v.get("workspace_path").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            let registry = app.state::<super::window::WindowRegistry>();
            registry
                .current_workspace
                .lock()
                .ok()
                .and_then(|cw| cw.clone())
                .ok_or_else(|| {
                    "No workspace path set. Please select a workspace first.".to_string()
                })?
        }
    };

    let cron_state = app.state::<super::cron::CronState>();
    let instance = cron_state
        .try_instance_for(&workspace_path)
        .await
        .ok_or_else(|| format!("Cron not initialized for workspace: {}", workspace_path))?;

    let job = instance
        .storage
        .get_job(job_id)
        .await
        .ok_or_else(|| format!("Job not found: {}", job_id))?;

    let scheduler = instance.scheduler.clone();
    tokio::spawn(async move {
        scheduler.execute_job(job).await;
    });

    Ok(format!(r#"{{"ok":true,"job_id":"{}"}}"#, job_id))
}

async fn handle_session_export(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let req: super::session_export::SessionExportRequest =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;
    let cache_state = app.state::<crate::local_cache::commands::LocalCacheState>();
    super::session_export::export_session_handler(&cache_state, req).await
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Read the WeCom ownerId from the config file.
/// Returns the ownerId or an error if not configured.
fn resolve_wecom_owner_id(app: &AppHandle) -> Result<String, String> {
    let workspace_path = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };

    let config = teamclu_gateway::read_config(&workspace_path)?;
    let owner_id = config
        .channels
        .as_ref()
        .and_then(|ch| ch.wecom.as_ref())
        .and_then(|w| w.owner_id.as_ref())
        .filter(|s| !s.is_empty())
        .cloned()
        .ok_or(
            "No WeCom target specified and ownerId is not set. \
             Send a DM to the bot first so ownerId is auto-recorded, \
             or pass an explicit target."
                .to_string(),
        )?;

    Ok(owner_id)
}

/// Detect WeCom media type from filename extension.
fn detect_media_type(filename: &str) -> &'static str {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" => "image",
        "mp3" | "amr" | "wav" | "ogg" | "m4a" | "aac" => "voice",
        "mp4" | "mov" | "avi" | "mkv" | "wmv" => "video",
        _ => "file",
    }
}

// ─── Knowledge Handlers ──────────────────────────────────────────────────────

async fn handle_knowledge_search(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let query = v
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: query")?
        .to_string();
    let top_k = v.get("top_k").and_then(|v| v.as_u64()).map(|n| n as usize);

    let workspace_path = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };

    let rag_state = app.state::<super::knowledge::RagState>();
    let result =
        super::knowledge::rag_search(workspace_path, query, top_k, None, None, rag_state).await?;

    serde_json::to_string(&result).map_err(|e| format!("Serialization error: {e}"))
}

async fn handle_knowledge_add(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let content = v
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: content")?;
    let title = v
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled");
    let filename = v.get("filename").and_then(|v| v.as_str());

    let workspace_path = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };

    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let safe_filename = filename
        .map(|f| {
            if f.ends_with(".md") {
                f.to_string()
            } else {
                format!("{}.md", f)
            }
        })
        .unwrap_or_else(|| {
            let slug = title
                .chars()
                .map(|c| if c.is_alphanumeric() { c } else { '-' })
                .collect::<String>()
                .to_lowercase();
            let slug = slug.trim_matches('-').to_string();
            let ts = chrono::Utc::now().timestamp();
            format!("{slug}-{ts}.md")
        });

    let file_content = format!(
        "---\ntitle: \"{title}\"\ncreated: \"{now}\"\nupdated: \"{now}\"\n---\n\n{content}\n"
    );

    let rag_state = app.state::<super::knowledge::RagState>();
    super::knowledge::rag_save_memory(
        workspace_path,
        safe_filename.clone(),
        file_content,
        rag_state,
    )
    .await?;

    Ok(format!(r#"{{"ok":true,"filename":"{}"}}"#, safe_filename))
}

async fn handle_knowledge_list(app: &AppHandle, _body: &[u8]) -> Result<String, String> {
    let workspace_path = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };

    let memories = super::knowledge::rag_list_memories(workspace_path).await?;
    serde_json::to_string(&memories).map_err(|e| format!("Serialization error: {e}"))
}

async fn handle_knowledge_delete(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let filename = v
        .get("filename")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: filename")?
        .to_string();

    let workspace_path = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };

    let rag_state = app.state::<super::knowledge::RagState>();
    super::knowledge::rag_delete_memory(workspace_path, filename.clone(), rag_state).await?;

    Ok(format!(r#"{{"ok":true,"filename":"{}"}}"#, filename))
}

// ─── Env Var Handlers ────────────────────────────────────────────────────────

async fn handle_env_var_set(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let scope = v
        .get("scope")
        .and_then(|v| v.as_str())
        .unwrap_or("personal")
        .to_string();
    let key = v
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: key")?
        .to_string();
    let value = v
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: value")?
        .to_string();
    let description = v
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let category = v
        .get("category")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let node_id = v
        .get("nodeId")
        .or_else(|| v.get("node_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let team_id = v
        .get("teamId")
        .or_else(|| v.get("team_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Team-scope values live in the Cloud API, so a bearer has to come in with
    // the request. Personal-scope writes stay local and ignore it.
    let access_token = v
        .get("accessToken")
        .or_else(|| v.get("access_token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Paired with the token on purpose: it was minted by whichever server the
    // caller is pointed at, so the endpoint has to come from the same place.
    let cloud_api_url = v
        .get("cloudApiUrl")
        .or_else(|| v.get("cloud_api_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let workspace_path = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };
    let shared_secrets = app.state::<super::shared_secrets::SharedSecretsState>();
    super::env_vars::env_catalog_set_for_workspace(
        app,
        &shared_secrets,
        &workspace_path,
        &scope,
        key.clone(),
        value,
        description,
        category,
        node_id,
        team_id,
        access_token,
        cloud_api_url,
    )
    .await?;

    Ok(format!(r#"{{"ok":true,"key":"{}"}}"#, key))
}

async fn handle_env_var_delete(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let scope = v
        .get("scope")
        .and_then(|v| v.as_str())
        .unwrap_or("personal")
        .to_string();
    let key = v
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: key")?
        .to_string();
    let node_id = v
        .get("nodeId")
        .or_else(|| v.get("node_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let role = v
        .get("role")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let team_id = v
        .get("teamId")
        .or_else(|| v.get("team_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let access_token = v
        .get("accessToken")
        .or_else(|| v.get("access_token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Paired with the token on purpose: it was minted by whichever server the
    // caller is pointed at, so the endpoint has to come from the same place.
    let cloud_api_url = v
        .get("cloudApiUrl")
        .or_else(|| v.get("cloud_api_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let workspace_path = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };
    let shared_secrets = app.state::<super::shared_secrets::SharedSecretsState>();
    super::env_vars::env_catalog_delete_for_workspace(
        app,
        &shared_secrets,
        &workspace_path,
        &scope,
        key.clone(),
        node_id,
        role,
        team_id,
        access_token,
        cloud_api_url,
    )
    .await?;

    Ok(format!(r#"{{"ok":true,"key":"{}"}}"#, key))
}

// ─── Channel Handler ─────────────────────────────────────────────────────────

async fn handle_channel_set(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let channel = v
        .get("channel")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: channel")?;
    let patch = v.get("config").ok_or("Missing field: config")?;

    let valid_channels = [
        "wecom", "discord", "feishu", "email", "kook", "wechat", "seatalk",
    ];
    if !valid_channels.contains(&channel) {
        return Err(format!(
            "Unknown channel: '{}'. Valid: {}",
            channel,
            valid_channels.join(", ")
        ));
    }

    let workspace = {
        let registry = app.state::<super::window::WindowRegistry>();
        registry
            .current_workspace
            .lock()
            .ok()
            .and_then(|cw| cw.clone())
            .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())?
    };

    let mut json = super::env_vars::read_teamclu_json(&workspace)?;

    // Ensure channels object exists
    if json.get("channels").is_none() {
        json["channels"] = serde_json::json!({});
    }

    let channels = json["channels"]
        .as_object_mut()
        .ok_or("channels is not an object")?;

    // Merge patch fields into channel config (shallow merge)
    let ch_entry = channels
        .entry(channel.to_string())
        .or_insert_with(|| serde_json::json!({}));

    if let (Some(obj), Some(patch_obj)) = (ch_entry.as_object_mut(), patch.as_object()) {
        for (k, val) in patch_obj {
            obj.insert(k.clone(), val.clone());
        }
    } else {
        return Err("config must be a JSON object".to_string());
    }

    super::env_vars::write_teamclu_json(&workspace, &json)?;

    Ok(format!(r#"{{"ok":true,"channel":"{}"}}"#, channel))
}

fn resolve_workspace_path(app: &AppHandle, body: &serde_json::Value) -> Result<String, String> {
    if let Some(ws) = body
        .get("workspace")
        .or_else(|| body.get("workspace_path"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(ws.to_string());
    }
    let registry = app.state::<super::window::WindowRegistry>();
    registry
        .current_workspace
        .lock()
        .ok()
        .and_then(|cw| cw.clone())
        .ok_or_else(|| "No workspace path set. Please select a workspace first.".to_string())
}

/// Body: `{ "workspace"?: string }`. Returns the merged MCP server map from amuxd.
async fn handle_mcp_get(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value = if body.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?
    };
    let workspace = resolve_workspace_path(app, &v)?;
    let servers = super::daemon_http::get_mcp_via_daemon(&workspace).await?;
    serde_json::to_string(&servers).map_err(|e| format!("Serialization error: {e}"))
}

/// Body: `{ "workspace"?: string, "servers": { ... } }`. Replaces workspace MCP map.
async fn handle_mcp_put(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;
    let workspace = resolve_workspace_path(app, &v)?;
    let servers = v.get("servers").ok_or("Missing field: servers")?;
    if !servers.is_object() {
        return Err("servers must be a JSON object".to_string());
    }
    let result = super::daemon_http::put_mcp_via_daemon(&workspace, servers).await?;
    serde_json::to_string(&result).map_err(|e| format!("Serialization error: {e}"))
}

/// Archive a cloud session via `PATCH /v1/sessions/:id` with `{ archivedAt }`.
///
/// Body: `{ "session_id": "...", "archivedAt"?: ISO, "accessToken"?: "...", "cloudApiUrl"?: "..." }`.
/// Credentials fall back to the in-memory introspect auth bridge (pushed by the
/// frontend on sign-in / token refresh).
async fn handle_session_archive(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let session_id = v
        .get("session_id")
        .or_else(|| v.get("sessionId"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("Missing field: session_id")?;

    let archived_at = v
        .get("archivedAt")
        .or_else(|| v.get("archived_at"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    let body_token = v
        .get("accessToken")
        .or_else(|| v.get("access_token"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let body_url = v
        .get("cloudApiUrl")
        .or_else(|| v.get("cloud_api_url"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string());

    let (access_token, cloud_api_url) = match (body_token, body_url) {
        (Some(token), Some(url)) => (token, url),
        (Some(token), None) => {
            let url = super::oss_sync::get_fc_endpoint("");
            (token, url)
        }
        (None, url_opt) => {
            let bridge = app.state::<super::introspect_auth::IntrospectAuthState>();
            let (token, bridged_url) = bridge.get().ok_or_else(|| {
                "Not signed in: open TeamClu and sign in so archive_session can call the Cloud API."
                    .to_string()
            })?;
            (token, url_opt.unwrap_or(bridged_url))
        }
    };

    let endpoint = super::oss_sync::resolve_runtime_fc_endpoint(&cloud_api_url)?;
    let fc = super::oss_sync::fc_client::FcClient::new(endpoint, access_token);
    let path = format!("/v1/sessions/{}", session_id);
    let patch = serde_json::json!({ "archivedAt": archived_at });
    fc.patch_json(&path, &patch)
        .await
        .map_err(|e| format!("Cloud API archive failed: {e}"))?;

    // Best-effort local cache cleanup so the desktop list doesn't resurrect the row.
    let cache = app.state::<crate::local_cache::commands::LocalCacheState>();
    if let Err(e) = crate::local_cache::commands::soft_delete_session_best_effort(
        &cache,
        session_id,
        &archived_at,
    )
    .await
    {
        eprintln!("[IntrospectAPI] local cache soft-delete after archive failed: {e}");
    }

    let payload = serde_json::json!({
        "ok": true,
        "session_id": session_id,
        "archivedAt": archived_at,
    });
    serde_json::to_string(&payload).map_err(|e| format!("Serialization error: {e}"))
}

/// Fetch a stored Git credential by ref. Body: `{"workspace_path": "...", "credential_ref": "..."}`.
/// Returns `{"ok":true,"authKind":"...","credential":"..."}`. Used by the
/// `teamclu-askpass` shell helper (via `teamclu-introspect get-credential`)
/// to provide credentials to `git clone` over HTTPS.
//
// TODO(security): /git-credential-get returns plaintext credentials over an
// unauthenticated 127.0.0.1 socket. Any local process can call this and exfiltrate
// HTTPS tokens or SSH key paths. Follow-up: introduce a per-launch shared secret
// (file-mode 0600 under ~/.teamclu/) that the introspect sidecar and askpass
// helper both read, and require it as an X-Teamclu-Token header.
async fn handle_git_credential_get(_app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;
    let workspace_path = v
        .get("workspace_path")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: workspace_path")?;
    let credential_ref = v
        .get("credential_ref")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: credential_ref")?;

    let (auth_kind, credential) =
        super::team_share::custom_git::load_credential(workspace_path, credential_ref)?;

    let payload = serde_json::json!({
        "ok": true,
        "authKind": auth_kind,
        "credential": credential,
    });
    serde_json::to_string(&payload).map_err(|e| format!("Serialization error: {e}"))
}

/// Find the position of `\r\n\r\n` in `data`, returning the index of the first `\r`.
fn find_double_crlf(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|w| w == b"\r\n\r\n")
}

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Error" };
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await
}
