// Internal HTTP API server for the teamclaw-introspect MCP binary.
//
// Listens on 127.0.0.1:13144 and handles:
//   POST /send-wecom        — send a proactive WeCom message
//   POST /cron-run          — manually trigger a cron job
//   POST /team-sync-all     — trigger team sync
//   POST /knowledge-search  — semantic search in knowledge base
//   POST /knowledge-add     — save a memory entry
//   POST /knowledge-list    — list memory entries
//   POST /knowledge-delete  — delete a memory entry
//   POST /env-var-set       — create or update an env var
//   POST /env-var-delete    — delete an env var
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
                ("POST", "/channel-set") => handle_channel_set(&app_clone, body_bytes).await,
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
        teamclaw_gateway::wecom::send_proactive_message(chatid, chat_type, message).await?;
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

        teamclaw_gateway::wecom::upload_and_send_media(
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
    use super::opencode::OpenCodeState;
    use super::team::get_workspace_path;

    let opencode_state = app.state::<OpenCodeState>();
    let workspace = get_workspace_path(&opencode_state)?;
    let result = super::team_sync_all::sync_all(app, &workspace).await;
    serde_json::to_string(&result).map_err(|e| format!("Serialization error: {e}"))
}

async fn handle_cron_run(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let job_id = v
        .get("job_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: job_id")?;

    let cron_state = app.state::<super::cron::CronState>();

    let job = cron_state
        .storage
        .get_job(job_id)
        .await
        .ok_or_else(|| format!("Job not found: {}", job_id))?;

    let scheduler = cron_state.scheduler.clone();
    tokio::spawn(async move {
        scheduler.execute_job(job).await;
    });

    Ok(format!(r#"{{"ok":true,"job_id":"{}"}}"#, job_id))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Read the WeCom ownerId from the config file.
/// Returns the ownerId or an error if not configured.
fn resolve_wecom_owner_id(app: &AppHandle) -> Result<String, String> {
    let oc_state = app.state::<super::opencode::OpenCodeState>();
    let workspace_path = super::opencode::current_workspace_path(&oc_state)?;

    let config = teamclaw_gateway::read_config(&workspace_path)?;
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

    let oc_state = app.state::<super::opencode::OpenCodeState>();
    let workspace_path = super::opencode::current_workspace_path(&oc_state)?;

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

    let oc_state = app.state::<super::opencode::OpenCodeState>();
    let workspace_path = super::opencode::current_workspace_path(&oc_state)?;

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
    let oc_state = app.state::<super::opencode::OpenCodeState>();
    let workspace_path = super::opencode::current_workspace_path(&oc_state)?;

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

    let oc_state = app.state::<super::opencode::OpenCodeState>();
    let workspace_path = super::opencode::current_workspace_path(&oc_state)?;

    let rag_state = app.state::<super::knowledge::RagState>();
    super::knowledge::rag_delete_memory(workspace_path, filename.clone(), rag_state).await?;

    Ok(format!(r#"{{"ok":true,"filename":"{}"}}"#, filename))
}

// ─── Env Var Handlers ────────────────────────────────────────────────────────

async fn handle_env_var_set(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

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

    let oc_state = app.state::<super::opencode::OpenCodeState>();
    super::env_vars::env_var_set(oc_state, key.clone(), value, description).await?;

    Ok(format!(r#"{{"ok":true,"key":"{}"}}"#, key))
}

async fn handle_env_var_delete(app: &AppHandle, body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("JSON parse error: {}", e))?;

    let key = v
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("Missing field: key")?
        .to_string();

    let oc_state = app.state::<super::opencode::OpenCodeState>();
    super::env_vars::env_var_delete(oc_state, key.clone()).await?;

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

    let valid_channels = ["wecom", "discord", "feishu", "email", "kook", "wechat"];
    if !valid_channels.contains(&channel) {
        return Err(format!(
            "Unknown channel: '{}'. Valid: {}",
            channel,
            valid_channels.join(", ")
        ));
    }

    let oc_state = app.state::<super::opencode::OpenCodeState>();
    let workspace = super::opencode::current_workspace_path(&oc_state)?;

    let mut json = super::env_vars::read_teamclaw_json(&workspace)?;

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

    super::env_vars::write_teamclaw_json(&workspace, &json)?;

    Ok(format!(r#"{{"ok":true,"channel":"{}"}}"#, channel))
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
