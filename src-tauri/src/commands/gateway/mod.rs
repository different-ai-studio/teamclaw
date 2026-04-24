// Re-export everything from the teamclaw-gateway crate so that existing
// `crate::commands::gateway::*` paths throughout the main crate continue to work.
pub use teamclaw_gateway::*;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use futures::StreamExt;
use serde::Deserialize;
use tauri::State;

use crate::commands::opencode::OpenCodeState;

/// Gateway state managed by Tauri
pub struct GatewayState {
    pub discord_gateway: Mutex<Option<DiscordGateway>>,
    pub feishu_gateway: Mutex<Option<FeishuGateway>>,
    pub email_gateway: Mutex<Option<EmailGateway>>,
    pub kook_gateway: Mutex<Option<KookGateway>>,
    pub wecom_gateway: Mutex<Option<WeComGateway>>,
    pub wechat_gateway: Mutex<Option<WeChatGateway>>,
    /// Shared session mapping across all gateways
    pub shared_session_mapping: SessionMapping,
    /// Whether the shared session mapping has been initialized with a persistence path
    pub session_initialized: Mutex<bool>,
}

impl Default for GatewayState {
    fn default() -> Self {
        Self {
            discord_gateway: Mutex::new(None),
            feishu_gateway: Mutex::new(None),
            email_gateway: Mutex::new(None),
            kook_gateway: Mutex::new(None),
            wecom_gateway: Mutex::new(None),
            wechat_gateway: Mutex::new(None),
            shared_session_mapping: SessionMapping::new(),
            session_initialized: Mutex::new(false),
        }
    }
}

/// Ensure the shared session mapping is initialized with persistence
async fn ensure_session_initialized(gateway_state: &GatewayState, workspace_path: &str) {
    let needs_init = {
        let mut initialized = match gateway_state.session_initialized.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                eprintln!("[Gateway] session_initialized mutex was poisoned, recovering");
                poisoned.into_inner()
            }
        };
        if *initialized {
            false
        } else {
            *initialized = true;
            true
        }
    };

    if needs_init {
        gateway_state
            .shared_session_mapping
            .set_persist_path(workspace_path)
            .await;
    }
}

// ==================== Permission Auto-Approval ====================
// Component for automatically approving OpenCode permission requests from channels.
// Used by all gateways (Discord, Feishu, KOOK, Email) to avoid blocking on permissions.

/// OpenCode permission request
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct PermissionRequest {
    pub id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    pub permission: String, // "read", "write", "bash", "skill", "edit"
    #[serde(default)]
    pub patterns: Vec<String>,
    pub always: Option<Vec<String>>,
    pub metadata: Option<serde_json::Value>,
}

/// Permission auto-approval service
///
/// Independent component responsible for polling and auto-approving OpenCode permission requests.
/// Can be composed into any gateway to avoid code duplication.
///
/// Supports automatic approval for both parent sessions and child sessions (subagents).
pub struct PermissionAutoApprover {
    opencode_port: u16,
    polling_interval: Duration,
    max_duration: Duration,
}

impl PermissionAutoApprover {
    /// Create a new auto-approver
    pub fn new(opencode_port: u16) -> Self {
        Self {
            opencode_port,
            polling_interval: Duration::from_secs(2),
            max_duration: Duration::from_secs(600), // 10 minutes
        }
    }

    // NOTE: Permission approval is now integrated into the unified SSE handler
    // in poll_for_message_with_approval(). This struct is kept for backward compatibility.
}

// Implement Clone to allow gateway cloning
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
// Send message to OpenCode using async endpoint (/prompt_async) with permission auto-approval.
// This matches the frontend behavior: fire-and-forget message send, then listen for SSE events.

/// Send message to OpenCode asynchronously and wait for response via SSE
///
/// This function:
/// 1. Sends message to /prompt_async (returns immediately)
/// 2. Starts permission auto-approval task
/// 3. Listens to SSE events for message completion
/// 4. Returns the complete response text
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
                break; // Only prefix the first text part
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

/// Unified SSE handler using a pre-established SSE connection.
/// SSE must be connected BEFORE sending the prompt to avoid missing events.
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
    // Wall-clock deadline: timeout must apply while waiting on stream.next(), otherwise a
    // stalled SSE connection (no chunks forever) never reaches a timeout check and blocks
    // per-session queues (e.g. WeChat) until the process is restarted.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);

    // Track sessions (parent + children) for permission approval
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

        // Process complete SSE events (ends with \n\n)
        while let Some(pos) = buffer.find("\n\n") {
            let event_text = buffer[..pos].to_string();
            buffer = buffer[pos + 2..].to_string();

            // Parse SSE event (skip verbose raw event logging)
            if let Some(event) = parse_sse_event(&event_text) {
                let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

                // Extract session ID from event (different locations for different event types)
                let event_session_id = event
                    .get("properties")
                    .and_then(|p| {
                        // Try direct sessionID first
                        p.get("sessionID")
                            .or_else(|| p.get("sessionId"))
                            .or_else(|| p.get("info").and_then(|info| info.get("sessionID")))
                            .or_else(|| p.get("info").and_then(|info| info.get("sessionId")))
                            .or_else(|| p.get("part").and_then(|part| part.get("sessionID")))
                            .or_else(|| p.get("part").and_then(|part| part.get("sessionId")))
                    })
                    .and_then(|s| s.as_str());

                // Process different event types
                match event_type {
                    "session.created" => {
                        // Check if this is a child session of our parent
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

                        // Only track child sessions that belong to our parent session
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
                        // Ignore all other session.created events
                        continue;
                    }

                    "permission.asked" => {
                        // Check if this permission is for any of our tracked sessions
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
                                        "[Gateway-{}] ✅ Auto-approving permission {} for '{}'",
                                        &session_id[..session_id.len().min(8)],
                                        perm_id_str,
                                        permission
                                    );

                                    // Auto-approve (fire and forget, don't block message waiting)
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
                                    "[Gateway-{}] ⚠️ Permission for untracked session: {}",
                                    &session_id[..session_id.len().min(8)],
                                    sess_id
                                );
                            }
                        }
                        // Ignore all other permission events
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
                        // CRITICAL: Only process message events for our target session
                        // Ignore all other sessions to avoid interference
                        if event_session_id != Some(session_id) {
                            continue;
                        }
                        // Check if this is a new assistant message (created after our send)
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

                            // Check if this is a new assistant message (created after our send)
                            if role == Some("assistant")
                                && created_time.is_some()
                                && created_time.unwrap() >= send_timestamp_ms
                                && message_id.is_some()
                            {
                                let msg_id = message_id.unwrap();

                                // Check if this message is completed (has completed timestamp)
                                if completed_time.is_some() {
                                    let finish_reason = info.get("finish").and_then(|f| f.as_str());

                                    // Only return if this is a final message (not just tool-calls)
                                    // If finish="tool-calls", OpenCode will continue with another assistant message
                                    if finish_reason != Some("tool-calls") {
                                        println!(
                                            "[Gateway-{}] Message completed, fetching content",
                                            &session_id[..session_id.len().min(8)]
                                        );

                                        // Fetch the complete message content
                                        return fetch_message_content(port, session_id, msg_id)
                                            .await;
                                    }
                                    // Tool-calls only, continue waiting
                                } else {
                                    // Message started but not completed yet
                                    if new_message_id.is_none() {
                                        new_message_id = Some(msg_id.to_string());
                                    }
                                }
                            }
                        }
                    }

                    _ => {
                        // For all other events, only process if they're for our target session
                        if event_session_id != Some(session_id) {
                            continue;
                        }
                        // Otherwise just log and ignore
                    }
                }
            }
        }
    }
}

/// Parse a single SSE event from text
fn parse_sse_event(text: &str) -> Option<serde_json::Value> {
    // SSE format: "data: {...}\n"
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
async fn fetch_message_content(
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

    // Find the message with matching ID
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
/// Prefers "text" parts but falls back to "reasoning" parts if no text is found
/// (some models only produce reasoning/thinking output for certain tasks).
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
// Shared functions for querying and switching models via OpenCode API.
// Used by Discord, Feishu, and other gateways for the /model command.
//
// Model switching is per-context (per DM user, per channel, per chat).
// The preference is stored in SessionMapping with a "model:" prefixed key.
// When sending messages, the gateway includes the model in the request body
// so OpenCode uses the selected model for that specific request.

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

    // Get both current config and providers in parallel
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
fn format_model_list(
    models: &[ModelInfo],
    active_model: &str,
    is_custom: bool,
    locale: i18n::Locale,
) -> String {
    const MAX_LENGTH: usize = 1900; // Leave buffer for Discord's 2000 char limit

    let mut text = String::new();
    if is_custom {
        text.push_str(&i18n::t(
            i18n::MsgKey::CurrentModelCustom(active_model),
            locale,
        ));
    } else {
        text.push_str(&i18n::t(
            i18n::MsgKey::CurrentModelDefault(active_model),
            locale,
        ));
    }
    text.push_str(&i18n::t(i18n::MsgKey::AvailableModels, locale));

    let footer = i18n::t(i18n::MsgKey::ModelSwitchUsage, locale);
    let footer_len = footer.len();

    // Group models by provider for better readability
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

            // Check if adding this provider would exceed the limit
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

                // Check if adding this line would exceed the limit
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
fn format_model_switched(new_model: &str, locale: i18n::Locale) -> String {
    i18n::t(i18n::MsgKey::ModelSwitched(new_model), locale)
}

/// Handle the /model command logic (shared between gateways).
/// Model preference is stored per-context in SessionMapping's `model` field.
///
/// - `port`: OpenCode server port
/// - `session_mapping`: for storing/retrieving model preference
/// - `session_key`: the session context key (e.g., "discord:dm:123", "feishu:chat_xyz")
/// - `arg`: optional model name to switch to (empty means list, "default" means reset)
pub async fn handle_model_command(
    port: u16,
    session_mapping: &SessionMapping,
    session_key: &str,
    arg: &str,
    locale: i18n::Locale,
) -> String {
    let arg = arg.trim();

    if arg.is_empty() {
        // List models and show current preference
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
        // Reset to default model
        session_mapping.remove_model(session_key).await;
        i18n::t(i18n::MsgKey::ModelResetToDefault, locale)
    } else {
        // Validate model exists then store preference
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
// Shared functions for listing and switching sessions via OpenCode API.
// Used by Discord and Feishu gateways for the /sessions command.

/// Information about a single OpenCode session (for listing)
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub updated: i64,
    pub archived: bool,
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
                // Skip sessions with empty title (likely just created / unused)
                if title.is_empty() || title == "(untitled)" {
                    // Still include them but with a placeholder
                }
                let archived = s["time"]["archived"].as_i64().is_some();
                Some(SessionInfo {
                    id,
                    title,
                    updated,
                    archived,
                })
            })
            .collect(),
        None => return Err("Unexpected session list format".to_string()),
    };

    // Sort by updated time descending (most recent first)
    sessions.sort_by(|a, b| b.updated.cmp(&a.updated));
    sessions.truncate(MAX_SESSIONS_LIST);

    Ok(sessions)
}

/// Archive a session in OpenCode by setting `time.archived` timestamp.
pub async fn opencode_archive_session(port: u16, session_id: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("http://127.0.0.1:{}/session", port);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let body = serde_json::json!({
        "sessionID": session_id,
        "time": { "archived": now_ms }
    });

    let resp = client
        .patch(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to archive session: {}", e))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Err(format!("Archive session failed ({}): {}", status, text))
    }
}

/// Fetch the latest assistant message text from a session
async fn fetch_latest_assistant_message(
    port: u16,
    session_id: &str,
    locale: i18n::Locale,
) -> Result<String, String> {
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

    // Find the last assistant message
    for msg in messages.iter().rev() {
        let role = msg["info"]["role"].as_str().unwrap_or("");
        if role == "assistant" {
            // Extract text from parts
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
                    // Truncate to ~500 chars for chat display
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
fn format_relative_time(timestamp_secs: i64, locale: i18n::Locale) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // OpenCode timestamps may be in seconds or milliseconds
    let ts = if timestamp_secs > 1_000_000_000_000 {
        timestamp_secs / 1000 // milliseconds -> seconds
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
///
/// - `port`: OpenCode server port
/// - `session_mapping`: for storing/retrieving session binding
/// - `session_key`: the current channel context key
/// - `arg`: optional session number to switch to (empty means list)
pub async fn handle_sessions_command(
    port: u16,
    session_mapping: &SessionMapping,
    session_key: &str,
    arg: &str,
    locale: i18n::Locale,
) -> String {
    let arg = arg.trim();

    if arg.is_empty() {
        // List sessions
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
        // Switch to session by number
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

                // Fetch latest assistant message
                match fetch_latest_assistant_message(port, &target.id, locale).await {
                    Ok(latest) => i18n::t(
                        i18n::MsgKey::SwitchedToSessionWithLatest(title, &latest),
                        locale,
                    ),
                    Err(_) => i18n::t(i18n::MsgKey::SwitchedToSessionNoLatest(title), locale),
                }
            }
            Err(e) => i18n::t(i18n::MsgKey::FailedToListSessions(&e), locale),
        }
    }
}

// ==================== OpenCode Stop/Abort Helper ====================

/// Handle the /stop command logic (shared between gateways).
/// Aborts the currently running task in the active session.
///
/// - `port`: OpenCode server port
/// - `session_mapping`: for looking up the current session
/// - `session_key`: the current channel context key
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
                i18n::t(
                    i18n::MsgKey::FailedToStopSessionWithStatus(status.as_u16(), &body),
                    locale,
                )
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
    let dir = format!("{}/{}", workspace_path, super::TEAMCLAW_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {} directory: {}", super::TEAMCLAW_DIR, e))
}

/// Get config file path from workspace (.teamclaw/teamclaw.json)
fn get_config_path(workspace_path: &str) -> String {
    format!("{}/{}/teamclaw.json", workspace_path, super::TEAMCLAW_DIR)
}

/// Read configuration from file
pub(crate) fn read_config(workspace_path: &str) -> Result<OpenCodeJsonConfigWithChannels, String> {
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
pub(crate) fn write_config(
    workspace_path: &str,
    config: &OpenCodeJsonConfigWithChannels,
) -> Result<(), String> {
    ensure_teamclaw_dir(workspace_path)?;
    let path = get_config_path(workspace_path);

    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&path, content).map_err(|e| format!("Failed to write config file: {}", e))
}

/// Get channel configuration
#[tauri::command]
pub async fn get_channel_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<ChannelsConfig, String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let config = read_config(&workspace_path)?;
    Ok(config.channels.unwrap_or_default())
}

/// Save channel configuration
#[tauri::command]
pub async fn save_channel_config(
    channels: ChannelsConfig,
    opencode_state: State<'_, OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut config = read_config(&workspace_path)?;
    config.channels = Some(channels);
    write_config(&workspace_path, &config)
}

/// Get Discord configuration specifically
#[tauri::command]
pub async fn get_discord_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<Option<config::DiscordConfig>, String> {
    let channels = get_channel_config(opencode_state).await?;
    Ok(channels.discord)
}

/// Save Discord configuration
#[tauri::command]
pub async fn save_discord_config(
    discord: config::DiscordConfig,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.discord = Some(discord.clone());
    write_config(&workspace_path, &config)?;

    let gateway_clone = {
        let gateway = gateway_state
            .discord_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.set_config(discord).await;
    }

    Ok(())
}

/// Set the locale in teamclaw.json for gateway i18n
#[tauri::command]
pub async fn set_config_locale(
    opencode_state: State<'_, OpenCodeState>,
    locale: String,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;
    let mut config = read_config(&workspace_path)?;
    config.locale = Some(locale);
    write_config(&workspace_path, &config)
}

/// Start the Discord gateway
#[tauri::command]
pub async fn start_gateway(
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let (workspace_path, port) =
        crate::commands::opencode::resolve_workspace(&opencode_state, None)?;

    println!("[Gateway] Reading config from: {}", workspace_path);
    let config = read_config(&workspace_path)?;
    let discord_config = config
        .channels
        .and_then(|c| c.discord)
        .ok_or("Discord configuration not found")?;

    println!(
        "[Gateway] Discord config loaded: enabled={}, guilds={:?}",
        discord_config.enabled,
        discord_config.guilds.keys().collect::<Vec<_>>()
    );

    ensure_session_initialized(&gateway_state, &workspace_path).await;

    let gateway_clone = {
        let mut gateway_guard = gateway_state
            .discord_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        let session_mapping = gateway_state.shared_session_mapping.clone();
        let gateway = gateway_guard.get_or_insert_with(|| {
            DiscordGateway::new(port, session_mapping, workspace_path.clone())
        });
        gateway.clone()
    };

    println!("[Gateway] Setting config on gateway...");
    gateway_clone.set_config(discord_config).await;

    println!("[Gateway] Config set, starting gateway...");
    gateway_clone.start().await
}

/// Stop the Discord gateway
#[tauri::command]
pub async fn stop_gateway(gateway_state: State<'_, GatewayState>) -> Result<(), String> {
    let gateway_clone = {
        let gateway_guard = gateway_state
            .discord_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        gateway_guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gateway) = gateway_clone {
        gateway.stop().await
    } else {
        Err("Discord gateway is not initialized".to_string())
    }
}

/// Get gateway status
#[tauri::command]
pub async fn get_gateway_status(
    gateway_state: State<'_, GatewayState>,
) -> Result<GatewayStatusResponse, String> {
    let gateway_clone = {
        let gateway_guard = gateway_state
            .discord_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        gateway_guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gateway) = gateway_clone {
        Ok(gateway.get_status().await)
    } else {
        Ok(GatewayStatusResponse::default())
    }
}

/// Test Discord token validity
#[tauri::command]
pub async fn test_discord_token(token: String) -> Result<String, String> {
    DiscordGateway::test_token(&token).await
}

// ========== Feishu Gateway Commands ==========

/// Get Feishu configuration
#[tauri::command]
pub async fn get_feishu_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<Option<feishu_config::FeishuConfig>, String> {
    let channels = get_channel_config(opencode_state).await?;
    Ok(channels.feishu)
}

/// Save Feishu configuration
#[tauri::command]
pub async fn save_feishu_config(
    feishu: feishu_config::FeishuConfig,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.feishu = Some(feishu.clone());
    write_config(&workspace_path, &config)?;

    let gateway_clone = {
        let gateway = gateway_state
            .feishu_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.set_config(feishu).await;
    }

    Ok(())
}

/// Start the Feishu gateway
#[tauri::command]
pub async fn start_feishu_gateway(
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let (workspace_path, port) =
        crate::commands::opencode::resolve_workspace(&opencode_state, None)?;

    let config = read_config(&workspace_path)?;
    let feishu_config = config
        .channels
        .and_then(|c| c.feishu)
        .ok_or("Feishu configuration not found")?;

    println!(
        "[Gateway] Feishu config loaded: enabled={}, app_id={}",
        feishu_config.enabled, feishu_config.app_id
    );

    ensure_session_initialized(&gateway_state, &workspace_path).await;

    let gateway_clone = {
        let mut gateway_guard = gateway_state
            .feishu_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        let session_mapping = gateway_state.shared_session_mapping.clone();
        let gateway = gateway_guard.get_or_insert_with(|| {
            FeishuGateway::new(port, session_mapping, workspace_path.clone())
        });
        gateway.clone()
    };

    gateway_clone.set_config(feishu_config).await;
    gateway_clone.start().await
}

/// Stop the Feishu gateway
#[tauri::command]
pub async fn stop_feishu_gateway(gateway_state: State<'_, GatewayState>) -> Result<(), String> {
    let gateway_clone = {
        let gateway_guard = gateway_state
            .feishu_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway_guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gateway) = gateway_clone {
        gateway.stop().await
    } else {
        Err("Feishu gateway is not initialized".to_string())
    }
}

/// Get Feishu gateway status
#[tauri::command]
pub async fn get_feishu_gateway_status(
    gateway_state: State<'_, GatewayState>,
) -> Result<FeishuGatewayStatusResponse, String> {
    let gateway_clone = {
        let gateway_guard = gateway_state
            .feishu_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway_guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gateway) = gateway_clone {
        Ok(gateway.get_status().await)
    } else {
        Ok(FeishuGatewayStatusResponse::default())
    }
}

/// Test Feishu credentials validity
#[tauri::command]
pub async fn test_feishu_credentials(app_id: String, app_secret: String) -> Result<String, String> {
    FeishuGateway::test_credentials(&app_id, &app_secret).await
}

/// Update the shared gateway model preference for an existing OpenCode session.
#[tauri::command]
pub async fn sync_gateway_session_model(
    session_id: String,
    model: Option<String>,
    gateway_state: State<'_, GatewayState>,
) -> Result<bool, String> {
    let session_mapping = gateway_state.shared_session_mapping.clone();
    let Some(session_key) = session_mapping.find_key_by_session_id(&session_id).await else {
        return Ok(false);
    };

    match model {
        Some(model_str) if !model_str.trim().is_empty() => {
            session_mapping
                .set_model(session_key, model_str.trim().to_string())
                .await;
        }
        _ => {
            session_mapping.remove_model(&session_key).await;
        }
    }

    Ok(true)
}

// ========== Email Gateway Commands ==========

/// Get Email configuration
#[tauri::command]
pub async fn get_email_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<Option<email_config::EmailConfig>, String> {
    let channels = get_channel_config(opencode_state).await?;
    Ok(channels.email)
}

/// Save Email configuration
#[tauri::command]
pub async fn save_email_config(
    email: email_config::EmailConfig,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.email = Some(email.clone());
    write_config(&workspace_path, &config)?;

    let gateway_clone = {
        let gateway = gateway_state
            .email_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.set_config(email).await;
    }

    Ok(())
}

/// Start the Email gateway
#[tauri::command]
pub async fn start_email_gateway(
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let (workspace_path, port) =
        crate::commands::opencode::resolve_workspace(&opencode_state, None)?;

    let config = read_config(&workspace_path)?;
    let email_config = config
        .channels
        .and_then(|c| c.email)
        .ok_or("Email configuration not found")?;

    println!(
        "[Gateway] Email config loaded: enabled={}, provider={:?}",
        email_config.enabled, email_config.provider
    );

    ensure_session_initialized(&gateway_state, &workspace_path).await;

    let gateway_clone = {
        let mut gateway_guard = gateway_state
            .email_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        let session_mapping = gateway_state.shared_session_mapping.clone();
        let gateway = gateway_guard.get_or_insert_with(|| EmailGateway::new(port, session_mapping));
        gateway.clone()
    };

    gateway_clone.set_config(email_config).await;
    gateway_clone.set_workspace_path(&workspace_path).await;
    gateway_clone.start().await
}

/// Stop the Email gateway
#[tauri::command]
pub async fn stop_email_gateway(gateway_state: State<'_, GatewayState>) -> Result<(), String> {
    let gateway_clone = {
        let gateway_guard = gateway_state
            .email_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway_guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gateway) = gateway_clone {
        gateway.stop().await
    } else {
        Err("Email gateway is not initialized".to_string())
    }
}

/// Get Email gateway status
#[tauri::command]
pub async fn get_email_gateway_status(
    gateway_state: State<'_, GatewayState>,
) -> Result<email_config::EmailGatewayStatusResponse, String> {
    let gateway_clone = {
        let gateway_guard = gateway_state
            .email_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway_guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gateway) = gateway_clone {
        Ok(gateway.get_status().await)
    } else {
        Ok(email_config::EmailGatewayStatusResponse::default())
    }
}

/// Test Email IMAP/SMTP connection
#[tauri::command]
pub async fn test_email_connection(email: email_config::EmailConfig) -> Result<String, String> {
    EmailGateway::test_connection(&email).await
}

/// Authorize Gmail OAuth2 (opens browser)
#[tauri::command]
pub async fn gmail_authorize(
    client_id: String,
    client_secret: String,
    email: String,
    opencode_state: State<'_, OpenCodeState>,
) -> Result<String, String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    EmailGateway::gmail_authorize(&client_id, &client_secret, &email, &workspace_path).await
}

/// Check if Gmail OAuth2 tokens exist
#[tauri::command]
pub async fn check_gmail_auth(opencode_state: State<'_, OpenCodeState>) -> Result<bool, String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    Ok(EmailGateway::check_gmail_auth(&workspace_path).await)
}

// ==================== KOOK Commands ====================

/// Get KOOK configuration
#[tauri::command]
pub async fn get_kook_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<kook_config::KookConfig, String> {
    let channels = get_channel_config(opencode_state).await?;
    Ok(channels.kook.unwrap_or_default())
}

/// Save KOOK configuration
#[tauri::command]
pub async fn save_kook_config(
    kook: kook_config::KookConfig,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.kook = Some(kook.clone());
    write_config(&workspace_path, &config)?;

    let gateway_clone = {
        let gateway = gateway_state
            .kook_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.set_config(kook).await;
    }

    Ok(())
}

/// Start KOOK gateway
#[tauri::command]
pub async fn start_kook_gateway(
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let (workspace_path, port) =
        crate::commands::opencode::resolve_workspace(&opencode_state, None)?;

    let config = read_config(&workspace_path)?;
    let kook_config = config
        .channels
        .and_then(|c| c.kook)
        .ok_or("KOOK configuration not found")?;

    println!(
        "[Gateway] KOOK config loaded: enabled={}, token={}",
        kook_config.enabled,
        if kook_config.token.is_empty() {
            "empty"
        } else {
            "***"
        }
    );

    ensure_session_initialized(&gateway_state, &workspace_path).await;

    if !kook_config.enabled {
        return Err("KOOK is not enabled".to_string());
    }

    let gateway_clone = {
        let mut guard = gateway_state
            .kook_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        if guard.is_none() {
            let gateway = KookGateway::new(
                port,
                gateway_state.shared_session_mapping.clone(),
                workspace_path.clone(),
            );
            *guard = Some(gateway);
        }

        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.set_config(kook_config).await;
        gw.start().await?;
    }

    Ok(())
}

/// Stop KOOK gateway
#[tauri::command]
pub async fn stop_kook_gateway(gateway_state: State<'_, GatewayState>) -> Result<(), String> {
    let gateway_clone = {
        let guard = gateway_state
            .kook_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.stop().await?;
    }

    Ok(())
}

/// Get KOOK gateway status
#[tauri::command]
pub async fn get_kook_gateway_status(
    gateway_state: State<'_, GatewayState>,
) -> Result<KookGatewayStatusResponse, String> {
    let gateway_clone = {
        let guard = gateway_state
            .kook_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        Ok(gw.get_status().await)
    } else {
        Ok(KookGatewayStatusResponse::default())
    }
}

/// Test KOOK bot token
#[tauri::command]
pub async fn test_kook_token(token: String) -> Result<String, String> {
    if token.is_empty() {
        return Err("Token is empty".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("{}/gateway/index?compress=0", kook::KOOK_API_BASE);

    match client
        .get(&url)
        .header("Authorization", format!("Bot {}", token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            match resp.json::<serde_json::Value>().await {
                Ok(body) => {
                    if let Some(code) = body.get("code").and_then(|c| c.as_i64()) {
                        if code == 0 {
                            Ok("Token is valid! Gateway connection successful.".to_string())
                        } else {
                            let message = body
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("Unknown error");
                            Err(format!("API error ({}): {}", code, message))
                        }
                    } else {
                        Err(format!("Unexpected response: {:?}", body))
                    }
                }
                Err(e) => Err(format!("HTTP {}: {}", status, e)),
            }
        }
        Err(e) => Err(format!("Connection failed: {}", e)),
    }
}

// ─── WeCom commands ──────────────────────────────────────────────────────────

/// Get WeCom configuration
#[tauri::command]
pub async fn get_wecom_config(
    workspace_path: Option<String>,
    opencode_state: State<'_, OpenCodeState>,
) -> Result<wecom_config::WeComConfig, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let config = read_config(&workspace_path)?;
    Ok(config
        .channels
        .and_then(|channels| channels.wecom)
        .unwrap_or_default())
}

/// Save WeCom configuration
#[tauri::command]
pub async fn save_wecom_config(
    wecom: wecom_config::WeComConfig,
    workspace_path: Option<String>,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &opencode_state)?;

    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.wecom = Some(wecom.clone());
    write_config(&workspace_path, &config)?;

    let gateway_clone = {
        let gateway = gateway_state
            .wecom_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone.filter(|gw| gw.workspace_path() == workspace_path) {
        gw.set_config(wecom).await;
    }

    Ok(())
}

/// Start WeCom gateway
#[tauri::command]
pub async fn start_wecom_gateway(
    workspace_path: Option<String>,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let (workspace_path, port) = crate::commands::opencode::resolve_workspace(
        &opencode_state,
        workspace_path.as_deref(),
    )?;

    println!(
        "[Gateway] start_wecom_gateway called, workspace={}",
        workspace_path
    );
    let mut config = read_config(&workspace_path)?;
    println!(
        "[Gateway] config read ok, channels={}",
        config.channels.is_some()
    );
    let mut wecom_config = config
        .channels
        .as_ref()
        .and_then(|c| c.wecom.clone())
        .ok_or("WeCom configuration not found")?;
    println!(
        "[Gateway] wecom_config found, enabled={}, bot_id_empty={}",
        wecom_config.enabled,
        wecom_config.bot_id.is_empty()
    );

    if !wecom_config.enabled {
        wecom_config.enabled = true;
        let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
        channels.wecom = Some(wecom_config.clone());
        write_config(&workspace_path, &config)?;
    }

    println!(
        "[Gateway] WeCom starting: enabled={}, bot_id={}",
        wecom_config.enabled,
        if wecom_config.bot_id.is_empty() {
            "empty"
        } else {
            "***"
        }
    );

    ensure_session_initialized(&gateway_state, &workspace_path).await;

    let gateway_clone = {
        let guard = gateway_state
            .wecom_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone.as_ref() {
        if gw.workspace_path() != workspace_path || gw.opencode_port() != port {
            gw.stop().await?;
            let mut guard = gateway_state
                .wecom_gateway
                .lock()
                .map_err(|e| e.to_string())?;
            *guard = None;
        }
    }

    let gateway_clone = {
        let mut guard = gateway_state
            .wecom_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        if guard.is_none() {
            let gateway = WeComGateway::new(
                port,
                gateway_state.shared_session_mapping.clone(),
                workspace_path.clone(),
            );
            *guard = Some(gateway);
        }

        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.set_config(wecom_config).await;
        gw.start().await?;
    }

    Ok(())
}

/// Stop WeCom gateway
#[tauri::command]
pub async fn stop_wecom_gateway(
    workspace_path: Option<String>,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let resolved_workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &opencode_state).ok();

    let gateway_clone = {
        let guard = gateway_state
            .wecom_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone.filter(|gw| {
        resolved_workspace_path
            .as_ref()
            .map(|path| gw.workspace_path() == path)
            .unwrap_or(true)
    }) {
        gw.stop().await?;
    }

    Ok(())
}

/// Get WeCom gateway status
#[tauri::command]
pub async fn get_wecom_gateway_status(
    workspace_path: Option<String>,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<WeComGatewayStatusResponse, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let gateway_clone = {
        let guard = gateway_state
            .wecom_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone.filter(|gw| gw.workspace_path() == workspace_path) {
        Ok(gw.get_status().await)
    } else {
        Ok(WeComGatewayStatusResponse::default())
    }
}

/// Test WeCom bot credentials
#[tauri::command]
pub async fn test_wecom_credentials(bot_id: String, secret: String) -> Result<String, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;

    if bot_id.is_empty() || secret.is_empty() {
        return Err("Bot ID and secret are required".to_string());
    }

    let (ws_stream, _) = connect_async(wecom::WECOM_WS_ENDPOINT)
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    let (mut sink, mut stream) = ws_stream.split();

    let subscribe = serde_json::json!({
        "cmd": "aibot_subscribe",
        "headers": { "req_id": uuid::Uuid::new_v4().to_string() },
        "body": { "bot_id": bot_id, "secret": secret }
    });

    sink.send(tokio_tungstenite::tungstenite::Message::Text(
        subscribe.to_string().into(),
    ))
    .await
    .map_err(|e| format!("Send failed: {}", e))?;

    let response = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
        .await
        .map_err(|_| "Timeout waiting for response".to_string())?
        .ok_or("Connection closed")?
        .map_err(|e| format!("Response error: {}", e))?;

    let _ = sink
        .send(tokio_tungstenite::tungstenite::Message::Close(None))
        .await;

    if let tokio_tungstenite::tungstenite::Message::Text(text) = response {
        let resp: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("Invalid response: {}", e))?;
        let code = resp.get("errcode").and_then(|c| c.as_i64()).unwrap_or(-1);
        if code == 0 {
            Ok("Credentials verified successfully".to_string())
        } else {
            let msg = resp
                .get("errmsg")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error");
            Err(format!("Verification failed (code {}): {}", code, msg))
        }
    } else {
        Err("Unexpected response type".to_string())
    }
}

/// Start WeCom QR code authorization
#[tauri::command]
pub async fn start_wecom_qr_auth() -> Result<wecom_config::WeComQrAuthStart, String> {
    wecom::fetch_wecom_qr_code().await
}

/// Poll WeCom QR code authorization result
#[tauri::command]
pub async fn poll_wecom_qr_auth(
    scode: String,
) -> Result<wecom_config::WeComQrAuthPollResult, String> {
    wecom::poll_wecom_qr_result(&scode).await
}

// ─── WeChat commands ─────────────────────────────────────────────────────────

/// Get WeChat configuration
#[tauri::command]
pub async fn get_wechat_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<wechat_config::WeChatConfig, String> {
    let channels = get_channel_config(opencode_state).await?;
    Ok(channels.wechat.unwrap_or_default())
}

/// Save WeChat configuration
#[tauri::command]
pub async fn save_wechat_config(
    wechat: wechat_config::WeChatConfig,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path = crate::commands::opencode::current_workspace_path(&opencode_state)?;

    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.wechat = Some(wechat.clone());
    write_config(&workspace_path, &config)?;

    let gateway_clone = {
        let gateway = gateway_state
            .wechat_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.set_config(wechat).await;
    }

    Ok(())
}

/// Start WeChat gateway
#[tauri::command]
pub async fn start_wechat_gateway(
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let (workspace_path, port) =
        crate::commands::opencode::resolve_workspace(&opencode_state, None)?;

    println!(
        "[Gateway] start_wechat_gateway called, workspace={}",
        workspace_path
    );
    let mut config = read_config(&workspace_path)?;
    println!(
        "[Gateway] config read ok, channels={}",
        config.channels.is_some()
    );
    let mut wechat_cfg = config
        .channels
        .as_ref()
        .and_then(|c| c.wechat.clone())
        .ok_or("WeChat configuration not found")?;
    println!(
        "[Gateway] wechat_config found, enabled={}, token_empty={}",
        wechat_cfg.enabled,
        wechat_cfg.bot_token.is_empty()
    );

    if !wechat_cfg.enabled {
        wechat_cfg.enabled = true;
        let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
        channels.wechat = Some(wechat_cfg.clone());
        write_config(&workspace_path, &config)?;
    }

    println!(
        "[Gateway] WeChat starting: enabled={}, token={}",
        wechat_cfg.enabled,
        if wechat_cfg.bot_token.is_empty() {
            "empty"
        } else {
            "***"
        }
    );

    ensure_session_initialized(&gateway_state, &workspace_path).await;

    let gateway_clone = {
        let mut guard = gateway_state
            .wechat_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        if guard.is_none() {
            let gateway = WeChatGateway::new(
                port,
                gateway_state.shared_session_mapping.clone(),
                workspace_path.clone(),
            );
            *guard = Some(gateway);
        }

        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.set_config(wechat_cfg).await;
        gw.start().await?;
    }

    Ok(())
}

/// Stop WeChat gateway
#[tauri::command]
pub async fn stop_wechat_gateway(gateway_state: State<'_, GatewayState>) -> Result<(), String> {
    let gateway_clone = {
        let guard = gateway_state
            .wechat_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.stop().await?;
    }

    Ok(())
}

/// Get WeChat gateway status
#[tauri::command]
pub async fn get_wechat_gateway_status(
    gateway_state: State<'_, GatewayState>,
) -> Result<WeChatGatewayStatusResponse, String> {
    let gateway_clone = {
        let guard = gateway_state
            .wechat_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        Ok(gw.get_status().await)
    } else {
        Ok(WeChatGatewayStatusResponse::default())
    }
}

/// Start WeChat QR login flow
#[tauri::command]
pub async fn start_wechat_qr_login() -> Result<WeChatQrLoginResponse, String> {
    wechat::fetch_qr_code(&wechat_config::default_ilink_base_url()).await
}

/// Poll WeChat QR login status
#[tauri::command]
pub async fn poll_wechat_qr_status(
    qrcode: String,
    opencode_state: State<'_, OpenCodeState>,
    _gateway_state: State<'_, GatewayState>,
) -> Result<WeChatQrStatusResponse, String> {
    let resp = wechat::poll_qr_status(&wechat_config::default_ilink_base_url(), &qrcode).await?;
    if resp.status == "confirmed" {
        if let (Some(token), Some(bot_id)) = (&resp.bot_token, &resp.ilink_bot_id) {
            let base_url = resp
                .baseurl
                .clone()
                .unwrap_or_else(wechat_config::default_ilink_base_url);
            let wechat_cfg = wechat_config::WeChatConfig {
                enabled: false,
                bot_token: token.clone(),
                account_id: bot_id.clone(),
                base_url,
                sync_buf: None,
                context_tokens: std::collections::HashMap::new(),
            };
            if let Ok(workspace_path) =
                crate::commands::opencode::current_workspace_path(&opencode_state)
            {
                if let Ok(mut config) = read_config(&workspace_path) {
                    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
                    channels.wechat = Some(wechat_cfg.clone());
                    let _ = write_config(&workspace_path, &config);
                }
            }
        }
    }
    Ok(resp)
}

/// Test WeChat connection
#[tauri::command]
pub async fn test_wechat_connection(bot_token: String) -> Result<String, String> {
    if bot_token.is_empty() {
        return Err("Bot token is required".to_string());
    }
    wechat::test_connection(&bot_token).await
}

/// Load personal shortcuts from the workspace config file (teamclaw.json).
#[tauri::command]
pub fn load_shortcuts(
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    workspace_path: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let config = read_config(&workspace_path)?;
    let shortcuts = config
        .other
        .get("shortcuts")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    Ok(shortcuts.as_array().cloned().unwrap_or_default())
}

/// Save personal shortcuts to the workspace config file (teamclaw.json).
#[tauri::command]
pub fn save_shortcuts(
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    nodes: Vec<serde_json::Value>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let mut config = read_config(&workspace_path)?;
    config
        .other
        .insert("shortcuts".to_string(), serde_json::json!(nodes));
    write_config(&workspace_path, &config)
}

/// Load the per-workspace system prompt from teamclaw.json. Returns "" if unset.
#[tauri::command]
pub fn load_system_prompt(
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let config = read_config(&workspace_path)?;
    Ok(config
        .other
        .get("systemPrompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// Save the per-workspace system prompt to teamclaw.json.
#[tauri::command]
pub fn save_system_prompt(
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    prompt: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let mut config = read_config(&workspace_path)?;
    config
        .other
        .insert("systemPrompt".to_string(), serde_json::json!(prompt));
    write_config(&workspace_path, &config)
}
