pub mod config;
pub mod discord;
pub mod email;
pub mod email_config;
pub mod email_db;
pub mod feishu;
pub mod feishu_config;
pub mod kook;
pub mod kook_config;
pub mod wecom;
pub mod wecom_config;
pub mod session;
pub mod session_queue;

pub use config::*;
pub use discord::DiscordGateway;
pub use email::EmailGateway;
pub use feishu::FeishuGateway;
pub use feishu_config::*;
pub use kook::KookGateway;
pub use kook_config::*;
pub use wecom::WeComGateway;
pub use wecom_config::*;
pub use session::SessionMapping;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;
use serde::Deserialize;
use futures_util::StreamExt;

use crate::commands::opencode::OpenCodeState;

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
    let client = reqwest::Client::new();
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

/// Gateway state managed by Tauri
pub struct GatewayState {
    pub discord_gateway: Mutex<Option<DiscordGateway>>,
    pub feishu_gateway: Mutex<Option<FeishuGateway>>,
    pub email_gateway: Mutex<Option<EmailGateway>>,
    pub kook_gateway: Mutex<Option<KookGateway>>,
    pub wecom_gateway: Mutex<Option<WeComGateway>>,
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
            shared_session_mapping: SessionMapping::new(),
            session_initialized: Mutex::new(false),
        }
    }
}

/// Ensure the shared session mapping is initialized with persistence
async fn ensure_session_initialized(
    gateway_state: &GatewayState,
    workspace_path: &str,
) {
    let needs_init = {
        let mut initialized = gateway_state.session_initialized.lock().unwrap();
        if *initialized {
            false
        } else {
            *initialized = true;
            true
        }
    }; // MutexGuard is dropped here before the await
    
    if needs_init {
        gateway_state.shared_session_mapping.set_persist_path(workspace_path).await;
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
    pub permission: String,  // "read", "write", "bash", "skill", "edit"
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
) -> Result<String, String> {
    // Step 1: Send message asynchronously (non-blocking)
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/session/{}/prompt_async", port, session_id);
    
    let mut body = serde_json::json!({ "parts": parts });
    if let Some((provider_id, model_id)) = model {
        body["model"] = serde_json::json!({
            "providerID": provider_id,
            "modelID": model_id
        });
    }
    
    // Step 1.5: Record current timestamp (milliseconds since epoch)
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
    
    // Step 2 & 3: Use unified SSE stream to handle both message waiting and permission approval
    // This avoids having multiple SSE connections which can cause event conflicts
    poll_for_message_with_approval(port, session_id, send_timestamp_ms).await
}

/// Unified SSE handler: wait for assistant message AND auto-approve permissions
/// 
/// This function uses a SINGLE SSE connection to:
/// 1. Wait for the assistant's message completion (message.updated with completed time)
/// 2. Monitor for child session creation (session.created)
/// 3. Auto-approve permissions for parent and child sessions (permission.asked)
/// 
/// Using one SSE connection avoids event conflicts and duplicate processing.
async fn poll_for_message_with_approval(
    port: u16,
    session_id: &str,
    send_timestamp_ms: u64,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let sse_url = format!("http://127.0.0.1:{}/event", port);
    
    // Connect to SSE stream
    let response = client
        .get(&sse_url)
        .header("Accept", "text/event-stream")
        .timeout(Duration::from_secs(900)) // 15 minute timeout
        .send()
        .await
        .map_err(|e| format!("Failed to connect to SSE: {}", e))?;
    
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut new_message_id: Option<String> = None;
    let start_time = tokio::time::Instant::now();
    
    // Track sessions (parent + children) for permission approval
    let mut tracked_sessions = HashSet::new();
    tracked_sessions.insert(session_id.to_string());
    let mut approved_permission_ids = HashSet::new();
    
    println!("[Gateway-{}] Waiting for AI response (monitoring SSE)", &session_id[..8]);
    
    while let Some(chunk) = stream.next().await {
        // Check timeout
        if start_time.elapsed() > Duration::from_secs(900) {
            return Err("Timeout waiting for OpenCode response".to_string());
        }
        
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
                let event_session_id = event.get("properties")
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
                        let new_session_id = event.get("properties")
                            .and_then(|p| p.get("sessionID").or_else(|| p.get("info").and_then(|i| i.get("id"))))
                            .and_then(|id| id.as_str());
                        let parent_id = event.get("properties")
                            .and_then(|p| p.get("info").and_then(|i| i.get("parentID")))
                            .and_then(|p| p.as_str());
                        
                        // Only track child sessions that belong to our parent session
                        if parent_id == Some(session_id) && new_session_id.is_some() {
                            let child_id = new_session_id.unwrap().to_string();
                            if tracked_sessions.insert(child_id.clone()) {
                                println!("[Gateway-{}] Detected child session: {}", &session_id[..8], child_id);
                            }
                        }
                        // Ignore all other session.created events
                        continue;
                    }
                    
                    "permission.asked" => {
                        // Check if this permission is for any of our tracked sessions
                        let perm_session_id = event.get("properties")
                            .and_then(|p| p.get("sessionID"))
                            .and_then(|s| s.as_str());
                        let perm_id = event.get("properties")
                            .and_then(|p| p.get("id"))
                            .and_then(|id| id.as_str());
                        let permission = event.get("properties")
                            .and_then(|p| p.get("permission"))
                            .and_then(|perm| perm.as_str())
                            .unwrap_or("unknown");
                        
                        println!("[Gateway-{}] Permission event: id={:?}, sess={:?}, perm={}, tracked={:?}",
                            &session_id[..8], perm_id, perm_session_id, permission, &tracked_sessions);
                        
                        if let (Some(sess_id), Some(perm_id_str)) = (perm_session_id, perm_id) {
                            if tracked_sessions.contains(sess_id) {
                                if !approved_permission_ids.contains(perm_id_str) {
                                    println!("[Gateway-{}] ✅ Auto-approving permission {} for '{}'",
                                        &session_id[..8], perm_id_str, permission);
                                    
                                    // Auto-approve (fire and forget, don't block message waiting)
                                    let port_clone = port;
                                    let perm_id_clone = perm_id_str.to_string();
                                    tokio::spawn(async move {
                                        let client = reqwest::Client::new();
                                        let approve_url = format!("http://127.0.0.1:{}/permission/{}/reply", port_clone, perm_id_clone);
                                        let body = serde_json::json!({ "reply": "always" });
                                        
                                        match client.post(&approve_url).json(&body).send().await {
                                            Ok(resp) => {
                                                if resp.status().is_success() {
                                                    println!("[Gateway] Permission {} approved successfully", perm_id_clone);
                                                } else {
                                                    eprintln!("[Gateway] Permission {} approval failed: HTTP {}", perm_id_clone, resp.status());
                                                }
                                            },
                                            Err(e) => eprintln!("[Gateway] Failed to approve {}: {}", perm_id_clone, e),
                                        }
                                    });
                                    
                                    approved_permission_ids.insert(perm_id_str.to_string());
                                } else {
                                    println!("[Gateway-{}] Permission {} already approved", &session_id[..8], perm_id_str);
                                }
                            } else {
                                println!("[Gateway-{}] ⚠️ Permission for untracked session: {}", &session_id[..8], sess_id);
                            }
                        }
                        // Ignore all other permission events
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
                            let created_time = info.get("time")
                                .and_then(|t| t.get("created"))
                                .and_then(|c| c.as_u64());
                            let completed_time = info.get("time")
                                .and_then(|t| t.get("completed"))
                                .and_then(|c| c.as_u64());
                            let message_id = info.get("id").and_then(|id| id.as_str());
                            
                            // Check if this is a new assistant message (created after our send)
                            if role == Some("assistant") && 
                               created_time.is_some() && 
                               created_time.unwrap() >= send_timestamp_ms &&
                               message_id.is_some() {
                                
                                let msg_id = message_id.unwrap();
                                
                                // Check if this message is completed (has completed timestamp)
                                if completed_time.is_some() {
                                    let finish_reason = info.get("finish").and_then(|f| f.as_str());
                                    
                                    // Only return if this is a final message (not just tool-calls)
                                    // If finish="tool-calls", OpenCode will continue with another assistant message
                                    if finish_reason != Some("tool-calls") {
                                        println!("[Gateway-{}] Message completed, fetching content", &session_id[..8]);
                                        
                                        // Fetch the complete message content
                                        return fetch_message_content(port, session_id, msg_id).await;
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
    
    Err("SSE stream ended unexpectedly".to_string())
}

/// Parse a single SSE event from text
fn parse_sse_event(text: &str) -> Option<serde_json::Value> {
    // SSE format: "data: {...}\n"
    for line in text.lines() {
        if let Some(data) = line.strip_prefix("data: ") {
            match serde_json::from_str::<serde_json::Value>(data) {
                Ok(json) => return Some(json),
                Err(e) => {
                    println!("[AsyncOpenCode] Failed to parse SSE data: {} (data: {})", e, &data[..data.len().min(100)]);
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
    let client = reqwest::Client::new();
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
        let msg_id = msg.get("info")
            .and_then(|info| info.get("id"))
            .and_then(|id| id.as_str());
        
        if msg_id == Some(message_id) {
            return extract_message_content(&msg);
        }
    }
    
    Err(format!("Message {} not found", message_id))
}

/// Extract text content from an OpenCode message
fn extract_message_content(message: &serde_json::Value) -> Result<String, String> {
    let parts = message.get("parts")
        .and_then(|p| p.as_array())
        .ok_or_else(|| "No parts in message".to_string())?;
    
    let mut content_parts = Vec::new();
    
    for part in parts.iter() {
        if let Some(part_type) = part.get("type").and_then(|t| t.as_str()) {
            if part_type == "text" {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    content_parts.push(text.to_string());
                }
            }
        }
    }
    
    if content_parts.is_empty() {
        return Err("No text content in message".to_string());
    }
    
    Ok(content_parts.join("\n"))
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
    let client = reqwest::Client::new();

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

    let current_model = config_body["model"]
        .as_str()
        .unwrap_or("")
        .to_string();

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
fn format_model_list(models: &[ModelInfo], active_model: &str, is_custom: bool) -> String {
    const MAX_LENGTH: usize = 1900; // Leave buffer for Discord's 2000 char limit
    
    let mut text = String::new();
    if is_custom {
        text.push_str(&format!("**Current Model:** `{}` (custom)\n\n", active_model));
    } else {
        text.push_str(&format!("**Current Model:** `{}` (default)\n\n", active_model));
    }
    text.push_str("**Available Models:**\n");

    let footer = "\n\nUse `/model <provider/model>` to switch.\nUse `/model default` to reset to default.";
    let footer_len = footer.len();
    
    // Group models by provider for better readability
    let mut provider_groups: std::collections::HashMap<String, Vec<&ModelInfo>> = std::collections::HashMap::new();
    for m in models {
        provider_groups.entry(m.provider.clone()).or_insert_with(Vec::new).push(m);
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
                let marker = if full_id == active_model { " ← current" } else { "" };
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
        text.push_str("\n_(List truncated due to length. Visit OpenCode UI for full model list.)_");
    }
    
    text.push_str(footer);
    text
}

/// Format the model switch success response
fn format_model_switched(new_model: &str) -> String {
    format!("Model switched to: `{}`\nAll subsequent messages in this context will use this model.", new_model)
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
                format_model_list(&models, active, is_custom)
            }
            Err(e) => format!("Failed to get models: {}", e),
        }
    } else if arg.eq_ignore_ascii_case("default") {
        // Reset to default model
        session_mapping.remove_model(session_key).await;
        "Model reset to default. Subsequent messages will use the global default model.".to_string()
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
                    format_model_switched(arg)
                } else {
                    format!(
                        "Model `{}` not found. Use `/model` to see available models.",
                        arg
                    )
                }
            }
            Err(e) => format!("Failed to get models: {}", e),
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
}

/// Maximum number of sessions to show in the list
const MAX_SESSIONS_LIST: usize = 10;

/// Fetch recent sessions from OpenCode, sorted by updated time descending
pub async fn opencode_list_sessions(port: u16) -> Result<Vec<SessionInfo>, String> {
    let client = reqwest::Client::new();
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
                Some(SessionInfo { id, title, updated })
            })
            .collect(),
        None => return Err("Unexpected session list format".to_string()),
    };

    // Sort by updated time descending (most recent first)
    sessions.sort_by(|a, b| b.updated.cmp(&a.updated));
    sessions.truncate(MAX_SESSIONS_LIST);

    Ok(sessions)
}

/// Fetch the latest assistant message text from a session
async fn fetch_latest_assistant_message(port: u16, session_id: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
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

    let messages = body
        .as_array()
        .ok_or("Unexpected message list format")?;

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

    Ok("(no assistant messages yet)".to_string())
}

/// Format a relative time string from a unix timestamp (seconds)
fn format_relative_time(timestamp_secs: i64) -> String {
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
        "just now".to_string()
    } else if diff < 3600 {
        let mins = diff / 60;
        format!("{} min ago", mins)
    } else if diff < 86400 {
        let hours = diff / 3600;
        format!("{} hr ago", hours)
    } else {
        let days = diff / 86400;
        format!("{} day ago", days)
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
) -> String {
    let arg = arg.trim();

    if arg.is_empty() {
        // List sessions
        match opencode_list_sessions(port).await {
            Ok(sessions) => {
                if sessions.is_empty() {
                    return "No sessions found.".to_string();
                }

                let current_session = session_mapping.get_session(session_key).await;

                let mut text = String::from("**Recent Sessions:**\n");
                for (i, s) in sessions.iter().enumerate() {
                    let time_str = format_relative_time(s.updated);
                    let title = if s.title.is_empty() { "(untitled)" } else { &s.title };
                    let marker = match &current_session {
                        Some(id) if *id == s.id => "  <-- current",
                        _ => "",
                    };
                    text.push_str(&format!(
                        "{}. {} ({}){}\n",
                        i + 1,
                        title,
                        time_str,
                        marker,
                    ));
                }
                text.push_str("\nUse `/sessions <number>` to switch.");
                text
            }
            Err(e) => format!("Failed to list sessions: {}", e),
        }
    } else {
        // Switch to session by number
        let num: usize = match arg.parse() {
            Ok(n) if n >= 1 => n,
            _ => return format!("`{}` is not a valid session number. Use `/sessions` to see the list.", arg),
        };

        match opencode_list_sessions(port).await {
            Ok(sessions) => {
                if num > sessions.len() {
                    return format!(
                        "Session #{} not found. There are only {} sessions.",
                        num,
                        sessions.len()
                    );
                }

                let target = &sessions[num - 1];
                session_mapping
                    .set_session(session_key.to_string(), target.id.clone())
                    .await;

                let title = if target.title.is_empty() {
                    "(untitled)"
                } else {
                    &target.title
                };

                // Fetch latest assistant message
                match fetch_latest_assistant_message(port, &target.id).await {
                    Ok(latest) => {
                        format!(
                            "Switched to session: \"{}\"\n\n**Latest response:**\n{}",
                            title, latest
                        )
                    }
                    Err(_) => {
                        format!(
                            "Switched to session: \"{}\"\n\nSubsequent messages will be sent to this session.",
                            title
                        )
                    }
                }
            }
            Err(e) => format!("Failed to list sessions: {}", e),
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
) -> String {
    let session_id = match session_mapping.get_session(session_key).await {
        Some(id) => id,
        None => return "No active session. Nothing to stop.".to_string(),
    };

    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/session/{}/abort", port, session_id);

    match client.post(&url).send().await {
        Ok(resp) => {
            if resp.status().is_success() {
                "Session processing stopped.".to_string()
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                format!("Failed to stop session ({}): {}", status, body)
            }
        }
        Err(e) => format!("Failed to stop session: {}", e),
    }
}

/// Configuration file structure for channels
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct OpenCodeJsonConfigWithChannels {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
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
fn read_config(workspace_path: &str) -> Result<OpenCodeJsonConfigWithChannels, String> {
    ensure_teamclaw_dir(workspace_path)?;
    let path = get_config_path(workspace_path);
    
    if !std::path::Path::new(&path).exists() {
        return Ok(OpenCodeJsonConfigWithChannels {
            schema: Some("https://opencode.ai/config.json".to_string()),
            ..Default::default()
        });
    }
    
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config file: {}", e))?;
    
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse config file: {}", e))
}

/// Write configuration to file
fn write_config(workspace_path: &str, config: &OpenCodeJsonConfigWithChannels) -> Result<(), String> {
    ensure_teamclaw_dir(workspace_path)?;
    let path = get_config_path(workspace_path);
    
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write config file: {}", e))
}

/// Get channel configuration
#[tauri::command]
pub async fn get_channel_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<ChannelsConfig, String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;
    
    let config = read_config(&workspace_path)?;
    Ok(config.channels.unwrap_or_default())
}

/// Save channel configuration
#[tauri::command]
pub async fn save_channel_config(
    channels: ChannelsConfig,
    opencode_state: State<'_, OpenCodeState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;
    
    let mut config = read_config(&workspace_path)?;
    config.channels = Some(channels);
    write_config(&workspace_path, &config)
}

/// Get Discord configuration specifically
#[tauri::command]
pub async fn get_discord_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<Option<DiscordConfig>, String> {
    let channels = get_channel_config(opencode_state).await?;
    Ok(channels.discord)
}

/// Save Discord configuration
#[tauri::command]
pub async fn save_discord_config(
    discord: DiscordConfig,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;
    
    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.discord = Some(discord.clone());
    write_config(&workspace_path, &config)?;
    
    // Update gateway config if it exists
    let gateway_clone = {
        let gateway = gateway_state.discord_gateway.lock().map_err(|e| e.to_string())?;
        gateway.as_ref().map(|gw| gw.clone())
    };
    
    if let Some(gw) = gateway_clone {
        gw.set_config(discord).await;
    }
    
    Ok(())
}

/// Start the Discord gateway
#[tauri::command]
pub async fn start_gateway(
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    // Get OpenCode port
    let port = *opencode_state
        .port
        .lock()
        .map_err(|e| e.to_string())?;
    
    // Get workspace path for config
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;
    
    // Read config
    println!("[Gateway] Reading config from: {}", workspace_path);
    let config = read_config(&workspace_path)?;
    let discord_config = config
        .channels
        .and_then(|c| c.discord)
        .ok_or("Discord configuration not found")?;
    
    println!("[Gateway] Discord config loaded: enabled={}, guilds={:?}", 
        discord_config.enabled, 
        discord_config.guilds.keys().collect::<Vec<_>>());
    
    // Ensure shared session mapping is initialized
    ensure_session_initialized(&gateway_state, &workspace_path).await;
    
    // Create or get gateway
    let gateway_clone = {
        let mut gateway_guard = gateway_state
            .discord_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        
        let session_mapping = gateway_state.shared_session_mapping.clone();
        let gateway = gateway_guard.get_or_insert_with(|| DiscordGateway::new(port, session_mapping));
        gateway.clone()
    };
    
    println!("[Gateway] Setting config on gateway...");
    gateway_clone.set_config(discord_config).await;
    
    println!("[Gateway] Config set, starting gateway...");
    gateway_clone.start().await
}

/// Stop the Discord gateway
#[tauri::command]
pub async fn stop_gateway(
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
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
pub async fn test_discord_token(
    token: String,
) -> Result<String, String> {
    DiscordGateway::test_token(&token).await
}

// ========== Feishu Gateway Commands ==========

/// Get Feishu configuration
#[tauri::command]
pub async fn get_feishu_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<Option<FeishuConfig>, String> {
    let channels = get_channel_config(opencode_state).await?;
    Ok(channels.feishu)
}

/// Save Feishu configuration
#[tauri::command]
pub async fn save_feishu_config(
    feishu: FeishuConfig,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.feishu = Some(feishu.clone());
    write_config(&workspace_path, &config)?;

    // Update gateway config if it exists
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
    let port = *opencode_state
        .port
        .lock()
        .map_err(|e| e.to_string())?;

    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    let config = read_config(&workspace_path)?;
    let feishu_config = config
        .channels
        .and_then(|c| c.feishu)
        .ok_or("Feishu configuration not found")?;

    println!(
        "[Gateway] Feishu config loaded: enabled={}, app_id={}",
        feishu_config.enabled, feishu_config.app_id
    );

    // Ensure shared session mapping is initialized
    ensure_session_initialized(&gateway_state, &workspace_path).await;

    let gateway_clone = {
        let mut gateway_guard = gateway_state
            .feishu_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        let session_mapping = gateway_state.shared_session_mapping.clone();
        let gateway = gateway_guard.get_or_insert_with(|| FeishuGateway::new(port, session_mapping));
        gateway.clone()
    };

    gateway_clone.set_config(feishu_config).await;
    gateway_clone.start().await
}

/// Stop the Feishu gateway
#[tauri::command]
pub async fn stop_feishu_gateway(
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
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
pub async fn test_feishu_credentials(
    app_id: String,
    app_secret: String,
) -> Result<String, String> {
    FeishuGateway::test_credentials(&app_id, &app_secret).await
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
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.email = Some(email.clone());
    write_config(&workspace_path, &config)?;

    // Update gateway config if it exists
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
    let port = *opencode_state
        .port
        .lock()
        .map_err(|e| e.to_string())?;

    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    let config = read_config(&workspace_path)?;
    let email_config = config
        .channels
        .and_then(|c| c.email)
        .ok_or("Email configuration not found")?;

    println!(
        "[Gateway] Email config loaded: enabled={}, provider={:?}",
        email_config.enabled, email_config.provider
    );

    // Ensure shared session mapping is initialized
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
pub async fn stop_email_gateway(
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
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
pub async fn test_email_connection(
    email: email_config::EmailConfig,
) -> Result<String, String> {
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
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    EmailGateway::gmail_authorize(&client_id, &client_secret, &email, &workspace_path).await
}

/// Check if Gmail OAuth2 tokens exist
#[tauri::command]
pub async fn check_gmail_auth(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<bool, String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    Ok(EmailGateway::check_gmail_auth(&workspace_path).await)
}

// ==================== KOOK Commands ====================

/// Get KOOK configuration
#[tauri::command]
pub async fn get_kook_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<KookConfig, String> {
    let channels = get_channel_config(opencode_state).await?;
    Ok(channels.kook.unwrap_or_default())
}

/// Save KOOK configuration
#[tauri::command]
pub async fn save_kook_config(
    kook: KookConfig,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.kook = Some(kook.clone());
    write_config(&workspace_path, &config)?;

    // Update gateway config if it exists
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
    let port = *opencode_state
        .port
        .lock()
        .map_err(|e| e.to_string())?;

    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    let config = read_config(&workspace_path)?;
    let kook_config = config
        .channels
        .and_then(|c| c.kook)
        .ok_or("KOOK configuration not found")?;

    println!(
        "[Gateway] KOOK config loaded: enabled={}, token={}",
        kook_config.enabled,
        if kook_config.token.is_empty() { "empty" } else { "***" }
    );

    // Ensure shared session mapping is initialized
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
            let gateway = KookGateway::new(port, gateway_state.shared_session_mapping.clone());
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
pub async fn stop_kook_gateway(
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
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

    let client = reqwest::Client::new();
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
    opencode_state: State<'_, OpenCodeState>,
) -> Result<WeComConfig, String> {
    let channels = get_channel_config(opencode_state).await?;
    Ok(channels.wecom.unwrap_or_default())
}

/// Save WeCom configuration
#[tauri::command]
pub async fn save_wecom_config(
    wecom: WeComConfig,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    let mut config = read_config(&workspace_path)?;
    let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
    channels.wecom = Some(wecom.clone());
    write_config(&workspace_path, &config)?;

    // Update gateway config if it exists
    let gateway_clone = {
        let gateway = gateway_state
            .wecom_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        gateway.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.set_config(wecom).await;
    }

    Ok(())
}

/// Start WeCom gateway
#[tauri::command]
pub async fn start_wecom_gateway(
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let port = *opencode_state
        .port
        .lock()
        .map_err(|e| e.to_string())?;

    let workspace_path = opencode_state
        .workspace_path
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    println!("[Gateway] start_wecom_gateway called, workspace={}", workspace_path);
    let mut config = read_config(&workspace_path)?;
    println!("[Gateway] config read ok, channels={}", config.channels.is_some());
    let mut wecom_config = config
        .channels
        .as_ref()
        .and_then(|c| c.wecom.clone())
        .ok_or("WeCom configuration not found")?;
    println!("[Gateway] wecom_config found, enabled={}, bot_id_empty={}", wecom_config.enabled, wecom_config.bot_id.is_empty());

    // Auto-enable WeCom when user explicitly clicks Start
    if !wecom_config.enabled {
        wecom_config.enabled = true;
        let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
        channels.wecom = Some(wecom_config.clone());
        write_config(&workspace_path, &config)?;
    }

    println!(
        "[Gateway] WeCom starting: enabled={}, bot_id={}",
        wecom_config.enabled,
        if wecom_config.bot_id.is_empty() { "empty" } else { "***" }
    );

    // Ensure shared session mapping is initialized
    ensure_session_initialized(&gateway_state, &workspace_path).await;

    let gateway_clone = {
        let mut guard = gateway_state
            .wecom_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        if guard.is_none() {
            let gateway = WeComGateway::new(port, gateway_state.shared_session_mapping.clone());
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
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let gateway_clone = {
        let guard = gateway_state
            .wecom_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        gw.stop().await?;
    }

    Ok(())
}

/// Get WeCom gateway status
#[tauri::command]
pub async fn get_wecom_gateway_status(
    gateway_state: State<'_, GatewayState>,
) -> Result<WeComGatewayStatusResponse, String> {
    let gateway_clone = {
        let guard = gateway_state
            .wecom_gateway
            .lock()
            .map_err(|e| e.to_string())?;
        guard.as_ref().map(|gw| gw.clone())
    };

    if let Some(gw) = gateway_clone {
        Ok(gw.get_status().await)
    } else {
        Ok(WeComGatewayStatusResponse::default())
    }
}

/// Test WeCom bot credentials
#[tauri::command]
pub async fn test_wecom_credentials(
    bot_id: String,
    secret: String,
) -> Result<String, String> {
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

    sink.send(tokio_tungstenite::tungstenite::Message::Text(subscribe.to_string()))
        .await
        .map_err(|e| format!("Send failed: {}", e))?;

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stream.next(),
    )
    .await
    .map_err(|_| "Timeout waiting for response".to_string())?
    .ok_or("Connection closed")?
    .map_err(|e| format!("Response error: {}", e))?;

    let _ = sink.send(tokio_tungstenite::tungstenite::Message::Close(None)).await;

    if let tokio_tungstenite::tungstenite::Message::Text(text) = response {
        let resp: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid response: {}", e))?;
        // WeCom API uses "errcode"/"errmsg" fields (not "code"/"msg")
        let code = resp.get("errcode").and_then(|c| c.as_i64()).unwrap_or(-1);
        if code == 0 {
            Ok("Credentials verified successfully".to_string())
        } else {
            let msg = resp.get("errmsg").and_then(|m| m.as_str())
                .unwrap_or("Unknown error");
            Err(format!("Verification failed (code {}): {}", code, msg))
        }
    } else {
        Err("Unexpected response type".to_string())
    }
}
