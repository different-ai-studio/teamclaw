pub mod config;
pub mod discord;
pub mod email;
pub mod email_config;
pub mod email_db;
pub mod feishu;
pub mod feishu_config;
pub mod i18n;
pub mod kook;
pub mod kook_config;
pub mod mqtt_config;
pub mod pending_question;
pub mod session;
pub mod session_queue;
pub mod wechat;
pub mod wechat_config;
pub mod wecom;
pub mod wecom_config;

pub use config::*;
pub use discord::DiscordGateway;
pub use email::EmailGateway;
pub use feishu::FeishuGateway;
pub use feishu_config::*;
pub use kook::KookGateway;
pub use kook_config::*;
pub use pending_question::{
    extract_question_marker, format_question_message, handle_question_event, parse_question_event,
    ForwardedQuestion, PendingQuestionStore, QuestionContext,
};
pub use session::SessionMapping;
pub use wechat::WeChatGateway;
pub use wechat_config::*;
pub use wecom::WeComGateway;
pub use wecom_config::*;

use futures_util::StreamExt;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// The `.teamclaw` directory name, matching the main crate's `TEAMCLAW_DIR`.
pub const TEAMCLAW_DIR: &str = ".teamclaw";

/// The config file name inside TEAMCLAW_DIR: `teamclaw.json`.
pub const CONFIG_FILE_NAME: &str = "teamclaw.json";

/// Identity of the person who sent a message through a gateway channel.
#[derive(Debug, Clone)]
pub struct ChannelSender {
    pub platform: String,
    #[allow(dead_code)]
    pub external_id: String,
    pub display_name: String,
}

pub const MAX_PROCESSED_MESSAGES: usize = 1000;

#[derive(Debug, Clone, PartialEq)]
pub enum FilterResult {
    Allow,
    Ignore,
    UserNotAllowed,
    ChannelNotConfigured,
}

pub struct ProcessedMessageTracker {
    messages: HashSet<String>,
    max_size: usize,
}

impl ProcessedMessageTracker {
    pub fn new(max_size: usize) -> Self {
        Self {
            messages: HashSet::new(),
            max_size,
        }
    }

    pub fn is_duplicate(&mut self, id: &str) -> bool {
        if self.messages.contains(id) {
            return true;
        }
        self.messages.insert(id.to_string());
        if self.messages.len() > self.max_size {
            let to_remove: Vec<String> = self.messages.iter().take(100).cloned().collect();
            for r in to_remove {
                self.messages.remove(&r);
            }
        }
        false
    }
}

/// Create a new OpenCode session
pub async fn create_opencode_session(port: u16) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("http://127.0.0.1:{}/session", port);

    // Set an explicit title to avoid OpenCode auto-generating titles that might conflict
    let now = chrono::Local::now();
    let title = format!("New Chat {}", now.format("%Y-%m-%d %H:%M:%S"));
    let body = serde_json::json!({ "title": title });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create session: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to create session: HTTP {}",
            response.status()
        ));
    }

    let response_body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse session response: {}", e))?;

    response_body["id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "No session ID in response".to_string())
}

// ==================== Permission Auto-Approval ====================

/// OpenCode permission request
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct PermissionRequest {
    pub id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    pub permission: String,
    #[serde(default)]
    pub patterns: Vec<String>,
    pub always: Option<Vec<String>>,
    pub metadata: Option<serde_json::Value>,
}

/// Permission auto-approval service
pub struct PermissionAutoApprover {
    opencode_port: u16,
    polling_interval: Duration,
    max_duration: Duration,
}

impl PermissionAutoApprover {
    pub fn new(opencode_port: u16) -> Self {
        Self {
            opencode_port,
            polling_interval: Duration::from_secs(2),
            max_duration: Duration::from_secs(600),
        }
    }
}

impl Clone for PermissionAutoApprover {
    fn clone(&self) -> Self {
        Self {
            opencode_port: self.opencode_port,
            polling_interval: self.polling_interval,
            max_duration: self.max_duration,
        }
    }
}

// ==================== Async OpenCode Message Sending ====================

/// Send message to OpenCode asynchronously and wait for response via SSE
pub async fn send_message_async_with_approval(
    port: u16,
    session_id: &str,
    parts: Vec<serde_json::Value>,
    model: Option<(String, String)>,
    question_ctx: Option<QuestionContext>,
    sender: Option<&ChannelSender>,
) -> Result<String, String> {
    // Inject sender identity prefix into the first text part
    let mut parts = parts;
    if let Some(sender) = sender {
        for part in parts.iter_mut() {
            if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    let prefixed =
                        format!("[{}/{}] {}", sender.display_name, sender.platform, text);
                    part["text"] = serde_json::Value::String(prefixed);
                }
                break;
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Step 1: Connect to SSE FIRST to avoid missing events
    let sse_url = format!("http://127.0.0.1:{}/event", port);
    let sse_response = client
        .get(&sse_url)
        .header("Accept", "text/event-stream")
        .timeout(Duration::from_secs(900))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to SSE: {}", e))?;

    // Step 2: Send message asynchronously (SSE is already listening)
    let url = format!(
        "http://127.0.0.1:{}/session/{}/prompt_async",
        port, session_id
    );
    let mut body = serde_json::json!({ "parts": parts });
    if let Some((provider_id, model_id)) = model {
        body["model"] = serde_json::json!({
            "providerID": provider_id,
            "modelID": model_id
        });
    }

    let send_timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    client
        .post(&url)
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to send async message: {}", e))?;

    // Step 3: Process SSE events (connection already established)
    poll_for_message_with_approval_from_stream(
        sse_response,
        port,
        session_id,
        send_timestamp_ms,
        question_ctx,
    )
    .await
}

/// Inject a message into OpenCode session history without triggering AI response.
/// Used for collaborative messages that don't @Agent — records context silently.
pub async fn inject_context_no_reply(
    port: u16,
    session_id: &str,
    content: &str,
    sender_name: &str,
) -> Result<(), String> {
    let prefixed = format!("[{}] {}", sender_name, content);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let url = format!(
        "http://127.0.0.1:{}/session/{}/prompt_async",
        port, session_id
    );
    let body = serde_json::json!({
        "parts": [{ "type": "text", "text": prefixed }],
        "noReply": true,
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("inject_context_no_reply failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "inject_context_no_reply HTTP {} - {}",
            status, body_text
        ));
    }

    Ok(())
}

/// Unified SSE handler using a pre-established SSE connection.
async fn poll_for_message_with_approval_from_stream(
    sse_response: reqwest::Response,
    port: u16,
    session_id: &str,
    send_timestamp_ms: u64,
    question_ctx: Option<QuestionContext>,
) -> Result<String, String> {
    let mut stream = sse_response.bytes_stream();
    let mut buffer = String::new();
    let mut new_message_id: Option<String> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);

    let mut tracked_sessions = HashSet::new();
    tracked_sessions.insert(session_id.to_string());
    let mut approved_permission_ids = HashSet::new();

    println!(
        "[Gateway-{}] Waiting for AI response (monitoring SSE)",
        &session_id[..session_id.len().min(8)]
    );

    loop {
        let chunk = tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                return Err("Timeout waiting for OpenCode response".to_string());
            }
            chunk = stream.next() => chunk,
        };

        let Some(chunk) = chunk else {
            return Err("SSE stream ended unexpectedly".to_string());
        };

        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(pos) = buffer.find("\n\n") {
            let event_text = buffer[..pos].to_string();
            buffer = buffer[pos + 2..].to_string();

            if let Some(event) = parse_sse_event(&event_text) {
                let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

                let event_session_id = event
                    .get("properties")
                    .and_then(|p| {
                        p.get("sessionID")
                            .or_else(|| p.get("sessionId"))
                            .or_else(|| p.get("info").and_then(|info| info.get("sessionID")))
                            .or_else(|| p.get("info").and_then(|info| info.get("sessionId")))
                            .or_else(|| p.get("part").and_then(|part| part.get("sessionID")))
                            .or_else(|| p.get("part").and_then(|part| part.get("sessionId")))
                    })
                    .and_then(|s| s.as_str());

                match event_type {
                    "session.created" => {
                        let new_session_id = event
                            .get("properties")
                            .and_then(|p| {
                                p.get("sessionID")
                                    .or_else(|| p.get("info").and_then(|i| i.get("id")))
                            })
                            .and_then(|id| id.as_str());
                        let parent_id = event
                            .get("properties")
                            .and_then(|p| p.get("info").and_then(|i| i.get("parentID")))
                            .and_then(|p| p.as_str());

                        if parent_id == Some(session_id) && new_session_id.is_some() {
                            let child_id = new_session_id.unwrap().to_string();
                            if tracked_sessions.insert(child_id.clone()) {
                                println!(
                                    "[Gateway-{}] Detected child session: {}",
                                    &session_id[..session_id.len().min(8)],
                                    child_id
                                );
                            }
                        }
                        continue;
                    }

                    "permission.asked" => {
                        let perm_session_id = event
                            .get("properties")
                            .and_then(|p| p.get("sessionID"))
                            .and_then(|s| s.as_str());
                        let perm_id = event
                            .get("properties")
                            .and_then(|p| p.get("id"))
                            .and_then(|id| id.as_str());
                        let permission = event
                            .get("properties")
                            .and_then(|p| p.get("permission"))
                            .and_then(|perm| perm.as_str())
                            .unwrap_or("unknown");

                        println!("[Gateway-{}] Permission event: id={:?}, sess={:?}, perm={}, tracked={:?}",
                            &session_id[..session_id.len().min(8)], perm_id, perm_session_id, permission, &tracked_sessions);

                        if let (Some(sess_id), Some(perm_id_str)) = (perm_session_id, perm_id) {
                            if tracked_sessions.contains(sess_id) {
                                if !approved_permission_ids.contains(perm_id_str) {
                                    println!(
                                        "[Gateway-{}] Auto-approving permission {} for '{}'",
                                        &session_id[..session_id.len().min(8)],
                                        perm_id_str,
                                        permission
                                    );

                                    let port_clone = port;
                                    let perm_id_clone = perm_id_str.to_string();
                                    tokio::spawn(async move {
                                        let client = reqwest::Client::builder()
                                            .timeout(std::time::Duration::from_secs(30))
                                            .build()
                                            .unwrap_or_else(|_| reqwest::Client::new());
                                        let approve_url = format!(
                                            "http://127.0.0.1:{}/permission/{}/reply",
                                            port_clone, perm_id_clone
                                        );
                                        let body = serde_json::json!({ "reply": "always" });

                                        match client.post(&approve_url).json(&body).send().await {
                                            Ok(resp) => {
                                                if resp.status().is_success() {
                                                    println!("[Gateway] Permission {} approved successfully", perm_id_clone);
                                                } else {
                                                    eprintln!("[Gateway] Permission {} approval failed: HTTP {}", perm_id_clone, resp.status());
                                                }
                                            }
                                            Err(e) => eprintln!(
                                                "[Gateway] Failed to approve {}: {}",
                                                perm_id_clone, e
                                            ),
                                        }
                                    });

                                    approved_permission_ids.insert(perm_id_str.to_string());
                                } else {
                                    println!(
                                        "[Gateway-{}] Permission {} already approved",
                                        &session_id[..session_id.len().min(8)],
                                        perm_id_str
                                    );
                                }
                            } else {
                                println!(
                                    "[Gateway-{}] Permission for untracked session: {}",
                                    &session_id[..session_id.len().min(8)],
                                    sess_id
                                );
                            }
                        }
                        continue;
                    }

                    "question.asked" => {
                        if let Some(ref ctx) = question_ctx {
                            let prefix = &session_id[..session_id.len().min(8)];
                            handle_question_event(ctx, &event, port, prefix, &tracked_sessions)
                                .await;
                        }
                        continue;
                    }

                    "message.updated" => {
                        if event_session_id != Some(session_id) {
                            continue;
                        }
                        if let Some(info) = event.get("properties").and_then(|p| p.get("info")) {
                            let role = info.get("role").and_then(|r| r.as_str());
                            let created_time = info
                                .get("time")
                                .and_then(|t| t.get("created"))
                                .and_then(|c| c.as_u64());
                            let completed_time = info
                                .get("time")
                                .and_then(|t| t.get("completed"))
                                .and_then(|c| c.as_u64());
                            let message_id = info.get("id").and_then(|id| id.as_str());

                            if role == Some("assistant")
                                && created_time.is_some()
                                && created_time.unwrap() >= send_timestamp_ms
                                && message_id.is_some()
                            {
                                let msg_id = message_id.unwrap();

                                if completed_time.is_some() {
                                    let finish_reason = info.get("finish").and_then(|f| f.as_str());

                                    if finish_reason != Some("tool-calls") {
                                        println!(
                                            "[Gateway-{}] Message completed, fetching content",
                                            &session_id[..session_id.len().min(8)]
                                        );

                                        return fetch_message_content(port, session_id, msg_id)
                                            .await;
                                    }
                                } else {
                                    if new_message_id.is_none() {
                                        new_message_id = Some(msg_id.to_string());
                                    }
                                }
                            }
                        }
                    }

                    _ => {
                        if event_session_id != Some(session_id) {
                            continue;
                        }
                    }
                }
            }
        }
    }
}

/// Parse a single SSE event from text
pub fn parse_sse_event(text: &str) -> Option<serde_json::Value> {
    for line in text.lines() {
        if let Some(data) = line.strip_prefix("data: ") {
            match serde_json::from_str::<serde_json::Value>(data) {
                Ok(json) => return Some(json),
                Err(e) => {
                    println!(
                        "[AsyncOpenCode] Failed to parse SSE data: {} (data: {})",
                        e,
                        &data[..data.len().min(100)]
                    );
                }
            }
        }
    }
    None
}

/// Fetch message content by message ID
pub async fn fetch_message_content(
    port: u16,
    session_id: &str,
    message_id: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("http://127.0.0.1:{}/session/{}/message", port, session_id);

    let response = client
        .get(&url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch messages: {}", e))?;

    let messages: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse messages: {}", e))?;

    for msg in messages {
        let msg_id = msg
            .get("info")
            .and_then(|info| info.get("id"))
            .and_then(|id| id.as_str());

        if msg_id == Some(message_id) {
            return extract_message_content(&msg);
        }
    }

    Err(format!("Message {} not found", message_id))
}

/// Extract text content from an OpenCode message.
fn extract_message_content(message: &serde_json::Value) -> Result<String, String> {
    let parts = message
        .get("parts")
        .and_then(|p| p.as_array())
        .ok_or_else(|| "No parts in message".to_string())?;

    let mut text_parts = Vec::new();
    let mut reasoning_parts = Vec::new();

    for part in parts.iter() {
        if let Some(part_type) = part.get("type").and_then(|t| t.as_str()) {
            if part_type == "text" {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(text.to_string());
                }
            } else if part_type == "reasoning" {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    reasoning_parts.push(text.to_string());
                }
            }
        }
    }

    if !text_parts.is_empty() {
        Ok(text_parts.join("\n"))
    } else if !reasoning_parts.is_empty() {
        Ok(reasoning_parts.join("\n"))
    } else {
        Err("No text content in message".to_string())
    }
}

// ==================== OpenCode Model Helpers ====================

/// Information about a single model
#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
}

/// Get available models from OpenCode config providers, along with the global default
pub async fn opencode_get_available_models(port: u16) -> Result<(Vec<ModelInfo>, String), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let config_url = format!("http://127.0.0.1:{}/config", port);
    let providers_url = format!("http://127.0.0.1:{}/config/providers", port);

    let (config_resp, providers_resp) = tokio::join!(
        client.get(&config_url).send(),
        client.get(&providers_url).send()
    );

    let config_body: serde_json::Value = config_resp
        .map_err(|e| format!("Failed to get config: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse config: {}", e))?;

    let providers_body: serde_json::Value = providers_resp
        .map_err(|e| format!("Failed to get providers: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse providers: {}", e))?;

    let current_model = config_body["model"].as_str().unwrap_or("").to_string();

    let mut models = Vec::new();
    if let Some(providers) = providers_body["providers"].as_array() {
        for p in providers {
            let provider_id = p["id"].as_str().unwrap_or("").to_string();
            if let Some(model_map) = p["models"].as_object() {
                for (key, model) in model_map {
                    let model_id = model["id"].as_str().unwrap_or(key).to_string();
                    let model_name = model["name"].as_str().unwrap_or(&model_id).to_string();
                    models.push(ModelInfo {
                        id: model_id,
                        name: model_name,
                        provider: provider_id.clone(),
                    });
                }
            }
        }
    }

    Ok((models, current_model))
}

/// Format the model list response for chat commands
pub fn format_model_list(models: &[ModelInfo], active_model: &str, is_custom: bool, locale: i18n::Locale) -> String {
    const MAX_LENGTH: usize = 1900;

    let mut text = String::new();
    if is_custom {
        text.push_str(&i18n::t(i18n::MsgKey::CurrentModelCustom(active_model), locale));
    } else {
        text.push_str(&i18n::t(i18n::MsgKey::CurrentModelDefault(active_model), locale));
    }
    text.push_str(&i18n::t(i18n::MsgKey::AvailableModels, locale));

    let footer = i18n::t(i18n::MsgKey::ModelSwitchUsage, locale);
    let footer_len = footer.len();

    let mut provider_groups: std::collections::HashMap<String, Vec<&ModelInfo>> =
        std::collections::HashMap::new();
    for m in models {
        provider_groups
            .entry(m.provider.clone())
            .or_insert_with(Vec::new)
            .push(m);
    }

    let mut providers: Vec<_> = provider_groups.keys().collect();
    providers.sort();

    let mut truncated = false;
    for provider in providers {
        if let Some(models_in_provider) = provider_groups.get(provider) {
            let provider_header = format!("\n**{}:**\n", provider);

            if text.len() + provider_header.len() + footer_len > MAX_LENGTH {
                truncated = true;
                break;
            }

            text.push_str(&provider_header);

            for m in models_in_provider {
                let full_id = format!("{}/{}", m.provider, m.id);
                let marker = if full_id == active_model {
                    i18n::t(i18n::MsgKey::ModelCurrentMarker, locale)
                } else {
                    String::new()
                };
                let line = format!("• `{}` ({}){}\n", full_id, m.name, marker);

                if text.len() + line.len() + footer_len + 50 > MAX_LENGTH {
                    truncated = true;
                    break;
                }

                text.push_str(&line);
            }

            if truncated {
                break;
            }
        }
    }

    if truncated {
        text.push_str(&i18n::t(i18n::MsgKey::ModelListTruncated, locale));
    }

    text.push_str(&footer);
    text
}

/// Format the model switch success response
pub fn format_model_switched(new_model: &str, locale: i18n::Locale) -> String {
    i18n::t(i18n::MsgKey::ModelSwitched(new_model), locale)
}

/// Handle the /model command logic (shared between gateways).
pub async fn handle_model_command(
    port: u16,
    session_mapping: &SessionMapping,
    session_key: &str,
    arg: &str,
    locale: i18n::Locale,
) -> String {
    let arg = arg.trim();

    if arg.is_empty() {
        match opencode_get_available_models(port).await {
            Ok((models, default_model)) => {
                let stored = session_mapping.get_model(session_key).await;
                let (active, is_custom) = match &stored {
                    Some(m) => (m.as_str(), true),
                    None => (default_model.as_str(), false),
                };
                format_model_list(&models, active, is_custom, locale)
            }
            Err(e) => i18n::t(i18n::MsgKey::FailedToGetModels(&e.to_string()), locale),
        }
    } else if arg.eq_ignore_ascii_case("default") {
        session_mapping.remove_model(session_key).await;
        i18n::t(i18n::MsgKey::ModelResetToDefault, locale)
    } else {
        match opencode_get_available_models(port).await {
            Ok((models, _)) => {
                let exists = models
                    .iter()
                    .any(|m| format!("{}/{}", m.provider, m.id) == arg);
                if exists {
                    session_mapping
                        .set_model(session_key.to_string(), arg.to_string())
                        .await;
                    format_model_switched(arg, locale)
                } else {
                    i18n::t(i18n::MsgKey::ModelNotFound(arg), locale)
                }
            }
            Err(e) => i18n::t(i18n::MsgKey::FailedToGetModels(&e.to_string()), locale),
        }
    }
}

/// Parse a stored model preference string ("provider/model") into (providerID, modelID)
pub fn parse_model_preference(model_str: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = model_str.splitn(2, '/').collect();
    if parts.len() == 2 {
        Some((parts[0].to_string(), parts[1].to_string()))
    } else {
        None
    }
}

// ==================== OpenCode Session Helpers ====================

/// Information about a single OpenCode session (for listing)
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub updated: i64,
}

/// Maximum number of sessions to show in the list
const MAX_SESSIONS_LIST: usize = 10;

/// Fetch recent sessions from OpenCode, sorted by updated time descending
pub async fn opencode_list_sessions(port: u16) -> Result<Vec<SessionInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("http://127.0.0.1:{}/session", port);

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to list sessions: {}", e))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse sessions: {}", e))?;

    let mut sessions: Vec<SessionInfo> = match body.as_array() {
        Some(arr) => arr
            .iter()
            .filter_map(|s| {
                let id = s["id"].as_str()?.to_string();
                let title = s["title"].as_str().unwrap_or("(untitled)").to_string();
                let updated = s["time"]["updated"]
                    .as_i64()
                    .or_else(|| s["time"]["created"].as_i64())
                    .unwrap_or(0);
                Some(SessionInfo { id, title, updated })
            })
            .collect(),
        None => return Err("Unexpected session list format".to_string()),
    };

    sessions.sort_by(|a, b| b.updated.cmp(&a.updated));
    sessions.truncate(MAX_SESSIONS_LIST);

    Ok(sessions)
}

/// Fetch the latest assistant message text from a session
async fn fetch_latest_assistant_message(port: u16, session_id: &str, locale: i18n::Locale) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("http://127.0.0.1:{}/session/{}/message", port, session_id);

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch messages: {}", e))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse messages: {}", e))?;

    let messages = body.as_array().ok_or("Unexpected message list format")?;

    for msg in messages.iter().rev() {
        let role = msg["info"]["role"].as_str().unwrap_or("");
        if role == "assistant" {
            if let Some(parts) = msg["parts"].as_array() {
                let mut text_parts: Vec<String> = Vec::new();
                for part in parts {
                    if part["type"].as_str() == Some("text") {
                        if let Some(text) = part["text"].as_str() {
                            text_parts.push(text.to_string());
                        }
                    }
                }
                if !text_parts.is_empty() {
                    let full_text = text_parts.join("\n");
                    if full_text.len() > 500 {
                        let truncated: String = full_text.chars().take(500).collect();
                        return Ok(format!("{}...", truncated));
                    }
                    return Ok(full_text);
                }
            }
        }
    }

    Ok(i18n::t(i18n::MsgKey::NoAssistantMessages, locale))
}

/// Format a relative time string from a unix timestamp (seconds)
pub fn format_relative_time(timestamp_secs: i64, locale: i18n::Locale) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let ts = if timestamp_secs > 1_000_000_000_000 {
        timestamp_secs / 1000
    } else {
        timestamp_secs
    };

    let diff = now - ts;
    if diff < 60 {
        i18n::t(i18n::MsgKey::JustNow, locale)
    } else if diff < 3600 {
        let mins = diff / 60;
        i18n::t(i18n::MsgKey::MinAgo(mins), locale)
    } else if diff < 86400 {
        let hours = diff / 3600;
        i18n::t(i18n::MsgKey::HrAgo(hours), locale)
    } else {
        let days = diff / 86400;
        i18n::t(i18n::MsgKey::DayAgo(days), locale)
    }
}

/// Handle the /sessions command logic (shared between gateways).
pub async fn handle_sessions_command(
    port: u16,
    session_mapping: &SessionMapping,
    session_key: &str,
    arg: &str,
    locale: i18n::Locale,
) -> String {
    let arg = arg.trim();

    if arg.is_empty() {
        match opencode_list_sessions(port).await {
            Ok(sessions) => {
                if sessions.is_empty() {
                    return i18n::t(i18n::MsgKey::NoSessionsFound, locale);
                }

                let current_session = session_mapping.get_session(session_key).await;
                let untitled = i18n::t(i18n::MsgKey::Untitled, locale);
                let current_marker = i18n::t(i18n::MsgKey::CurrentSessionMarker, locale);

                let mut text = i18n::t(i18n::MsgKey::RecentSessions, locale);
                for (i, s) in sessions.iter().enumerate() {
                    let time_str = format_relative_time(s.updated, locale);
                    let title = if s.title.is_empty() {
                        &untitled
                    } else {
                        &s.title
                    };
                    let marker = match &current_session {
                        Some(id) if *id == s.id => &current_marker,
                        _ => "",
                    };
                    text.push_str(&format!("{}. {} ({}){}\n", i + 1, title, time_str, marker));
                }
                text.push_str(&i18n::t(i18n::MsgKey::SessionsSwitchUsage, locale));
                text
            }
            Err(e) => i18n::t(i18n::MsgKey::FailedToListSessions(&e), locale),
        }
    } else {
        let num: usize = match arg.parse() {
            Ok(n) if n >= 1 => n,
            _ => {
                return i18n::t(i18n::MsgKey::InvalidSessionNumber(arg), locale);
            }
        };

        match opencode_list_sessions(port).await {
            Ok(sessions) => {
                if num > sessions.len() {
                    return i18n::t(i18n::MsgKey::SessionNotFound(num, sessions.len()), locale);
                }

                let target = &sessions[num - 1];
                session_mapping
                    .set_session(session_key.to_string(), target.id.clone())
                    .await;

                let untitled = i18n::t(i18n::MsgKey::Untitled, locale);
                let title = if target.title.is_empty() {
                    &untitled
                } else {
                    &target.title
                };

                match fetch_latest_assistant_message(port, &target.id, locale).await {
                    Ok(latest) => {
                        i18n::t(i18n::MsgKey::SwitchedToSessionWithLatest(title, &latest), locale)
                    }
                    Err(_) => {
                        i18n::t(i18n::MsgKey::SwitchedToSessionNoLatest(title), locale)
                    }
                }
            }
            Err(e) => i18n::t(i18n::MsgKey::FailedToListSessions(&e), locale),
        }
    }
}

// ==================== OpenCode Stop/Abort Helper ====================

/// Handle the /stop command logic (shared between gateways).
pub async fn handle_stop_command(
    port: u16,
    session_mapping: &SessionMapping,
    session_key: &str,
    locale: i18n::Locale,
) -> String {
    let session_id = match session_mapping.get_session(session_key).await {
        Some(id) => id,
        None => return i18n::t(i18n::MsgKey::NoActiveSession, locale),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("http://127.0.0.1:{}/session/{}/abort", port, session_id);

    match client.post(&url).send().await {
        Ok(resp) => {
            if resp.status().is_success() {
                i18n::t(i18n::MsgKey::SessionStopped, locale)
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                i18n::t(i18n::MsgKey::FailedToStopSessionWithStatus(status.as_u16(), &body), locale)
            }
        }
        Err(e) => i18n::t(i18n::MsgKey::FailedToStopSession(&e.to_string()), locale),
    }
}

/// Configuration file structure for channels
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct OpenCodeJsonConfigWithChannels {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<ChannelsConfig>,
    #[serde(flatten)]
    pub other: HashMap<String, serde_json::Value>,
}

/// Ensure the .teamclaw directory exists in the workspace
pub fn ensure_teamclaw_dir(workspace_path: &str) -> Result<(), String> {
    let dir = format!("{}/{}", workspace_path, TEAMCLAW_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {} directory: {}", TEAMCLAW_DIR, e))
}

/// Get config file path from workspace (.teamclaw/teamclaw.json)
pub fn get_config_path(workspace_path: &str) -> String {
    format!("{}/{}/{}", workspace_path, TEAMCLAW_DIR, CONFIG_FILE_NAME)
}

/// Read configuration from file
pub fn read_config(workspace_path: &str) -> Result<OpenCodeJsonConfigWithChannels, String> {
    ensure_teamclaw_dir(workspace_path)?;
    let path = get_config_path(workspace_path);

    if !std::path::Path::new(&path).exists() {
        return Ok(OpenCodeJsonConfigWithChannels {
            schema: Some("https://opencode.ai/config.json".to_string()),
            ..Default::default()
        });
    }

    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config file: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse config file: {}", e))
}

/// Write configuration to file
pub fn write_config(
    workspace_path: &str,
    config: &OpenCodeJsonConfigWithChannels,
) -> Result<(), String> {
    ensure_teamclaw_dir(workspace_path)?;
    let path = get_config_path(workspace_path);

    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&path, content).map_err(|e| format!("Failed to write config file: {}", e))
}
