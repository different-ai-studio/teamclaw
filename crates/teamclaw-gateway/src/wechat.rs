use crate::i18n;
use crate::wechat_config::{
    WeChatConfig, WeChatGatewayStatus, WeChatGatewayStatusResponse, WeChatQrLoginResponse,
    WeChatQrStatusResponse,
};
use crate::{AcpHandle, ChannelStore};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, RwLock};

#[allow(dead_code)]
const ILINK_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const LONG_POLL_TIMEOUT_MS: u64 = 35_000;
const MAX_CONSECUTIVE_FAILURES: u32 = 3;
const BACKOFF_DELAY_MS: u64 = 30_000;
const RETRY_DELAY_MS: u64 = 2_000;
const CHANNEL_VERSION: &str = "0.1.0";

const MSG_TYPE_USER: u64 = 1;
const MSG_ITEM_TEXT: u64 = 1;
const MSG_ITEM_VOICE: u64 = 3;
const MSG_TYPE_BOT: u64 = 2;
const MSG_STATE_FINISH: u64 = 2;

// ---------------------------------------------------------------------------
// ilink message types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct ILinkTextItem {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ILinkVoiceItem {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ILinkRefMsg {
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ILinkMessageItem {
    #[serde(default, rename = "type")]
    item_type: Option<u64>,
    #[serde(default)]
    text_item: Option<ILinkTextItem>,
    #[serde(default)]
    voice_item: Option<ILinkVoiceItem>,
    #[serde(default)]
    ref_msg: Option<ILinkRefMsg>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct ILinkMessage {
    #[serde(default)]
    from_user_id: Option<String>,
    #[serde(default)]
    to_user_id: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    message_type: Option<u64>,
    #[serde(default)]
    item_list: Option<Vec<ILinkMessageItem>>,
    #[serde(default)]
    context_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GetUpdatesResponse {
    #[serde(default)]
    ret: Option<i32>,
    #[serde(default)]
    errcode: Option<i32>,
    #[serde(default)]
    errmsg: Option<String>,
    #[serde(default)]
    msgs: Option<Vec<ILinkMessage>>,
    #[serde(default)]
    get_updates_buf: Option<String>,
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

fn random_wechat_uin() -> String {
    use base64::Engine;
    let uint32: u32 = getrandom_u32();
    base64::engine::general_purpose::STANDARD.encode(uint32.to_string().as_bytes())
}

/// Generate a random u32 using getrandom (no `rand` crate needed)
fn getrandom_u32() -> u32 {
    let mut buf = [0u8; 4];
    getrandom::getrandom(&mut buf).unwrap_or_default();
    u32::from_le_bytes(buf)
}

fn build_ilink_headers(token: Option<&str>) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Content-Type", "application/json".parse().unwrap());
    headers.insert("AuthorizationType", "ilink_bot_token".parse().unwrap());
    headers.insert("X-WECHAT-UIN", random_wechat_uin().parse().unwrap());
    if let Some(t) = token {
        if !t.is_empty() {
            headers.insert(
                "Authorization",
                format!("Bearer {}", t.trim()).parse().unwrap(),
            );
        }
    }
    headers
}

// ---------------------------------------------------------------------------
// QR login functions (pub — used by Tauri commands)
// ---------------------------------------------------------------------------

/// Fetch QR code for WeChat login
pub async fn fetch_qr_code(base_url: &str) -> Result<WeChatQrLoginResponse, String> {
    let url = format!(
        "{}/ilink/bot/get_bot_qrcode?bot_type=3",
        base_url.trim_end_matches('/')
    );
    let client = crate::http_client_secs(30);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("QR fetch failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("QR fetch failed: HTTP {}", resp.status()));
    }
    resp.json::<WeChatQrLoginResponse>()
        .await
        .map_err(|e| format!("QR parse failed: {}", e))
}

/// Poll QR code scan status
pub async fn poll_qr_status(
    base_url: &str,
    qrcode: &str,
) -> Result<WeChatQrStatusResponse, String> {
    let url = format!(
        "{}/ilink/bot/get_qrcode_status?qrcode={}",
        base_url.trim_end_matches('/'),
        urlencoding::encode(qrcode)
    );
    let client = crate::try_http_client_secs(35).map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("iLink-App-ClientVersion", "1")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                return "timeout".to_string();
            }
            format!("QR status failed: {}", e)
        })?;
    if !resp.status().is_success() {
        return Err(format!("QR status failed: HTTP {}", resp.status()));
    }
    resp.json::<WeChatQrStatusResponse>()
        .await
        .map_err(|e| format!("QR status parse failed: {}", e))
}

// ---------------------------------------------------------------------------
// getupdates / sendmessage (pub — used by Tauri commands and cron delivery)
// ---------------------------------------------------------------------------

/// Long-poll for new messages
pub(crate) async fn get_updates(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    get_updates_buf: &str,
) -> Result<GetUpdatesResponse, String> {
    let url = format!("{}/ilink/bot/getupdates", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "get_updates_buf": get_updates_buf,
        "base_info": { "channel_version": CHANNEL_VERSION },
    });
    let headers = build_ilink_headers(Some(token));
    let resp = client
        .post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                return "timeout".to_string();
            }
            format!("getupdates failed: {}", e)
        })?;
    if !resp.status().is_success() {
        return Err(format!("getupdates HTTP {}", resp.status()));
    }
    resp.json::<GetUpdatesResponse>()
        .await
        .map_err(|e| format!("getupdates parse failed: {}", e))
}

/// Quick connection test using a short-timeout getupdates call.
pub async fn test_connection(bot_token: &str) -> Result<String, String> {
    let client = crate::try_http_client_secs(5).map_err(|e| e.to_string())?;
    let base_url = super::wechat_config::default_ilink_base_url();
    match get_updates(&client, &base_url, bot_token, "").await {
        Ok(_) => Ok("Connection successful".to_string()),
        Err(e) if e == "timeout" => Ok("Connection successful".to_string()),
        Err(e) => Err(e),
    }
}

/// Send a text message back to WeChat
pub async fn send_text_message(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    to_user_id: &str,
    text: &str,
    context_token: &str,
) -> Result<(), String> {
    let url = format!("{}/ilink/bot/sendmessage", base_url.trim_end_matches('/'));
    let client_id = format!(
        "teamclaw:{}-{:08x}",
        chrono::Utc::now().timestamp_millis(),
        getrandom_u32()
    );
    let body = serde_json::json!({
        "msg": {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": client_id,
            "message_type": MSG_TYPE_BOT,
            "message_state": MSG_STATE_FINISH,
            "item_list": [{ "type": MSG_ITEM_TEXT, "text_item": { "text": text } }],
            "context_token": context_token,
        },
        "base_info": { "channel_version": CHANNEL_VERSION },
    });
    let headers = build_ilink_headers(Some(token));
    let resp = client
        .post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sendmessage failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("sendmessage HTTP {}: {}", status, body));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Text extraction helper
// ---------------------------------------------------------------------------

fn text_from_text_item(item: &ILinkMessageItem) -> Option<String> {
    item.text_item
        .as_ref()
        .and_then(|ti| ti.text.as_ref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            if let Some(ref_msg) = &item.ref_msg {
                if let Some(title) = &ref_msg.title {
                    return format!("[引用: {}]\n{}", title, s);
                }
            }
            s.to_string()
        })
}

fn text_from_voice_item(item: &ILinkMessageItem) -> Option<String> {
    item.voice_item
        .as_ref()
        .and_then(|vi| vi.text.as_ref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Parse user-visible text from ilink `item_list`.
/// iLink occasionally omits `type` or uses values we have not mapped; still try text/voice payloads.
fn extract_text_from_message(msg: &ILinkMessage) -> String {
    let items = match &msg.item_list {
        Some(items) if !items.is_empty() => items,
        _ => return String::new(),
    };
    let mut fallback: Option<String> = None;

    for item in items {
        match item.item_type {
            Some(t) if t == MSG_ITEM_TEXT => {
                if let Some(s) = text_from_text_item(item) {
                    return s;
                }
            }
            Some(t) if t == MSG_ITEM_VOICE => {
                if let Some(s) = text_from_voice_item(item) {
                    return s;
                }
            }
            _ => {
                if let Some(s) = text_from_text_item(item) {
                    if fallback.is_none() {
                        fallback = Some(s);
                    }
                    continue;
                }
                if let Some(s) = text_from_voice_item(item) {
                    if fallback.is_none() {
                        fallback = Some(s);
                    }
                    continue;
                }
                eprintln!("[WeChat] Unknown message item type: {:?}", item.item_type);
            }
        }
    }

    fallback.unwrap_or_default()
}

// ---------------------------------------------------------------------------
// WeChatGateway struct
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct WeChatGateway {
    config: Arc<RwLock<WeChatConfig>>,
    pub acp: Arc<dyn AcpHandle>,
    pub store: Arc<dyn ChannelStore>,
    pub team_id: String,
    pub primary_agent_actor_id: String,
    pub agent_owner_actor_ids: Vec<String>,
    workspace_path: String,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<WeChatGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    pending_questions: Arc<super::PendingQuestionStore>,
    /// Cache of from_user_id -> context_token for replies
    context_tokens: Arc<RwLock<HashMap<String, String>>>,
}

impl WeChatGateway {
    pub fn new(
        acp: Arc<dyn AcpHandle>,
        store: Arc<dyn ChannelStore>,
        team_id: String,
        primary_agent_actor_id: String,
        agent_owner_actor_ids: Vec<String>,
        workspace_path: String,
    ) -> Self {
        Self {
            config: Arc::new(RwLock::new(WeChatConfig::default())),
            acp,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
            workspace_path,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(WeChatGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            pending_questions: Arc::new(super::PendingQuestionStore::new()),
            context_tokens: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn set_config(&self, config: WeChatConfig) {
        *self.config.write().await = config;
    }

    pub async fn get_status(&self) -> WeChatGatewayStatusResponse {
        self.status.read().await.clone()
    }

    async fn set_status(&self, status: WeChatGatewayStatus, error: Option<String>) {
        let mut s = self.status.write().await;
        s.status = status;
        s.error_message = error;
    }

    /// Get cached context_token for a user (used by cron delivery)
    #[allow(dead_code)]
    pub async fn get_context_token(&self, user_id: &str) -> Option<String> {
        self.context_tokens.read().await.get(user_id).cloned()
    }

    /// Send a message to a WeChat user (used by cron delivery and reply)
    pub async fn send_to_user(&self, to_user_id: &str, text: &str) -> Result<(), String> {
        let config = self.config.read().await;
        let context_token = self
            .context_tokens
            .read()
            .await
            .get(to_user_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "No context_token for user {}. User must send a message first.",
                    to_user_id
                )
            })?;
        let client = crate::http_client_secs(30);
        send_text_message(
            &client,
            &config.base_url,
            &config.bot_token,
            to_user_id,
            text,
            &context_token,
        )
        .await
    }

    /// Persist context_tokens from in-memory config to teamclaw.json on disk
    async fn persist_context_tokens(&self) {
        let config = self.config.read().await.clone();
        let path = format!(
            "{}/{}/{}",
            self.workspace_path,
            crate::TEAMCLAW_DIR,
            crate::CONFIG_FILE_NAME
        );
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut json: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return,
        };
        // Update only the contextTokens field under channels.wechat
        if let Some(wechat) = json.get_mut("channels").and_then(|c| c.get_mut("wechat")) {
            if let Ok(tokens_val) = serde_json::to_value(&config.context_tokens) {
                wechat["contextTokens"] = tokens_val;
            }
        }
        let _ = std::fs::write(
            &path,
            serde_json::to_string_pretty(&json).unwrap_or_default(),
        );
    }

    pub async fn start(&self) -> Result<(), String> {
        let is_running = *self.is_running.read().await;
        if is_running {
            return Err("WeChat gateway is already running".to_string());
        }

        let config = self.config.read().await.clone();
        if config.bot_token.is_empty() {
            return Err("WeChat bot_token is empty. Please complete QR login first.".to_string());
        }

        *self.is_running.write().await = true;
        self.set_status(WeChatGatewayStatus::Connecting, None).await;

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        let gateway = self.clone();
        tokio::spawn(async move {
            gateway.run_poll_loop(shutdown_rx).await;
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let tx = self.shutdown_tx.write().await.take();
        if let Some(tx) = tx {
            let _ = tx.send(());
        }
        *self.is_running.write().await = false;
        self.set_status(WeChatGatewayStatus::Disconnected, None)
            .await;
        Ok(())
    }

    /// Consuming shutdown used by the amuxd channel manager.
    pub async fn shutdown(self) {
        if let Err(e) = self.stop().await {
            eprintln!("[WeChat] shutdown: {e}");
        }
    }

    async fn run_poll_loop(&self, mut shutdown_rx: oneshot::Receiver<()>) {
        let config = self.config.read().await.clone();
        let mut get_updates_buf = config.sync_buf.unwrap_or_default();
        let mut consecutive_failures: u32 = 0;

        let client = crate::http_client(std::time::Duration::from_millis(
            LONG_POLL_TIMEOUT_MS + 5000,
        ));

        self.set_status(WeChatGatewayStatus::Connected, None).await;
        {
            let mut s = self.status.write().await;
            s.account_id = Some(config.account_id.clone());
        }
        println!("[WeChat] Gateway connected, starting long-poll loop");

        loop {
            // Check for shutdown
            match shutdown_rx.try_recv() {
                Ok(_) | Err(oneshot::error::TryRecvError::Closed) => {
                    println!("[WeChat] Shutdown signal received");
                    break;
                }
                Err(oneshot::error::TryRecvError::Empty) => {}
            }

            match get_updates(
                &client,
                &config.base_url,
                &config.bot_token,
                &get_updates_buf,
            )
            .await
            {
                Ok(resp) => {
                    // Check for API errors
                    let is_error = resp.ret.unwrap_or(0) != 0 || resp.errcode.unwrap_or(0) != 0;
                    if is_error {
                        consecutive_failures += 1;
                        let err_msg = format!(
                            "getupdates error: ret={:?} errcode={:?} errmsg={:?}",
                            resp.ret, resp.errcode, resp.errmsg
                        );
                        eprintln!("[WeChat] {}", err_msg);

                        // Check for auth errors (don't retry these)
                        if resp.errcode == Some(401) || resp.errcode == Some(403) {
                            self.set_status(
                                WeChatGatewayStatus::Error,
                                Some(
                                    "Token expired or invalid. Please re-authenticate.".to_string(),
                                ),
                            )
                            .await;
                            break;
                        }

                        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                            self.set_status(WeChatGatewayStatus::Error, Some(err_msg))
                                .await;
                            consecutive_failures = 0;
                            tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_DELAY_MS))
                                .await;
                        } else {
                            tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS))
                                .await;
                        }
                        continue;
                    }

                    consecutive_failures = 0;

                    // Save sync buf
                    if let Some(buf) = &resp.get_updates_buf {
                        get_updates_buf = buf.clone();
                        // Persist sync_buf to config
                        let mut cfg = self.config.write().await;
                        cfg.sync_buf = Some(buf.clone());
                    }

                    // Process messages
                    if let Some(msgs) = &resp.msgs {
                        for msg in msgs {
                            if msg.message_type != Some(MSG_TYPE_USER) {
                                continue;
                            }
                            let text = extract_text_from_message(msg);
                            if text.is_empty() {
                                eprintln!(
                                    "[WeChat] User message dropped: empty text after parse. from={:?}, items={:?}",
                                    msg.from_user_id, msg.item_list
                                );
                                continue;
                            }
                            let sender_id = msg
                                .from_user_id
                                .clone()
                                .unwrap_or_else(|| "unknown".to_string());

                            // Cache context token
                            if let Some(ct) = &msg.context_token {
                                self.context_tokens
                                    .write()
                                    .await
                                    .insert(sender_id.clone(), ct.clone());
                                // Persist context_token to config on disk
                                {
                                    let mut cfg = self.config.write().await;
                                    cfg.context_tokens.insert(sender_id.clone(), ct.clone());
                                }
                                self.persist_context_tokens().await;
                            }

                            let preview: String = text.chars().take(50).collect();
                            println!("[WeChat] Message from {}: {}...", sender_id, preview);

                            // Forward to amuxd ACP session
                            let gateway = self.clone();
                            let text_clone = text.clone();
                            let sender_clone = sender_id.clone();
                            tokio::spawn(async move {
                                if let Err(e) = gateway
                                    .handle_incoming_message(&sender_clone, &text_clone)
                                    .await
                                {
                                    eprintln!("[WeChat] Failed to handle message: {}", e);
                                }
                            });
                        }
                    }
                }
                Err(e) => {
                    if e == "timeout" {
                        // Normal long-poll timeout, just retry
                        continue;
                    }
                    consecutive_failures += 1;
                    eprintln!("[WeChat] Poll error: {}", e);
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                        self.set_status(WeChatGatewayStatus::Error, Some(e)).await;
                        consecutive_failures = 0;
                        tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_DELAY_MS))
                            .await;
                    } else {
                        tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                    }
                }
            }
        }

        *self.is_running.write().await = false;
        println!("[WeChat] Poll loop ended");
    }

    async fn handle_incoming_message(&self, sender_id: &str, text: &str) -> Result<(), String> {
        let locale = i18n::get_locale(&self.workspace_path);
        let trimmed = text.trim();

        // Forward /answer to pending question (must run before generic slash handler)
        if let Some(answer_text) = super::PendingQuestionStore::parse_answer_command(trimmed) {
            if let Some(qid) = self.pending_questions.try_answer(answer_text).await {
                println!(
                    "[WeChat] Question {} answered via /answer: {}",
                    qid, answer_text
                );
                let _ = self
                    .send_to_user(
                        sender_id,
                        &i18n::t(i18n::MsgKey::AnswerSubmitted(answer_text), locale),
                    )
                    .await;
            } else {
                let _ = self
                    .send_to_user(
                        sender_id,
                        &i18n::t(i18n::MsgKey::NoPendingQuestions, locale),
                    )
                    .await;
            }
            return Ok(());
        }

        // Handle slash commands. /help and /sessions are answered without
        // resolving a session; /stop, /reset, /model fall through to the
        // session-resolve path below (they need a resolved acp_session_id).
        let mut is_session_slash = false;
        let mut slash_lower = String::new();
        if !trimmed.is_empty() && trimmed.starts_with('/') {
            let lower = trimmed.to_lowercase();
            let needs_session = lower == "/stop"
                || lower == "/reset"
                || lower == "/model"
                || lower.starts_with("/model ");
            if needs_session {
                is_session_slash = true;
                slash_lower = lower;
            } else {
                let reply = self.handle_slash_command(trimmed, locale).await;
                let _ = self.send_to_user(sender_id, &reply).await;
                return Ok(());
            }
        }

        // WeChat-iLink is DM-only — no group concept on personal WeChat, so no @-mention filter.
        // Read account-level ilink identifier from config for binding/urn construction.
        let ilink_account = self.config.read().await.account_id.clone();
        let sender_display_name = if sender_id.is_empty() {
            "WeChat user".to_string()
        } else {
            sender_id.to_string()
        };

        let binding = crate::binding::wechat_dm(&ilink_account, sender_id);
        let urn = crate::binding::urn_wechat_user(&ilink_account, sender_id);

        let external_actor_id = self
            .store
            .ensure_external_actor(&self.team_id, "wechat", &urn, &sender_display_name)
            .await
            .map_err(|e| format!("ensure_external_actor: {e}"))?;

        let session_title = format!("WeChat DM: {}", sender_display_name);

        let outcome = self
            .store
            .ensure_session(
                &self.team_id,
                &binding,
                &session_title,
                &self.primary_agent_actor_id,
                &self.agent_owner_actor_ids,
                std::slice::from_ref(&external_actor_id),
            )
            .await
            .map_err(|e| format!("ensure_session: {e}"))?;

        if let Err(e) = self
            .store
            .add_participant(&outcome.session_id, &external_actor_id)
            .await
        {
            eprintln!("[WeChat] add_participant failed: {}", e);
        }

        // Slash-command dispatch — /stop /reset /model — against the resolved session.
        if is_session_slash {
            let reply_text = self
                .dispatch_session_slash_cmd(&slash_lower, &outcome.acp_session_id)
                .await;
            let _ = self.send_to_user(sender_id, &reply_text).await;
            return Ok(());
        }

        if let Err(e) = self
            .store
            .record_message(&outcome.session_id, &external_actor_id, text, None)
            .await
        {
            eprintln!("[WeChat] record_message (user) failed: {}", e);
        }

        // Drive a single ACP turn through amuxd.
        let reply = self
            .acp
            .send_prompt(&outcome.acp_session_id, &sender_display_name, text)
            .await
            .map_err(|e| format!("acp.send_prompt: {e}"))?;

        if let Err(e) = self
            .store
            .record_agent_reply(
                &outcome.session_id,
                &self.primary_agent_actor_id,
                &reply.reply_text,
                None,
            )
            .await
        {
            eprintln!("[WeChat] record_agent_reply failed: {}", e);
        }

        let reply_text = if reply.reply_text.trim().is_empty() {
            i18n::t(i18n::MsgKey::ModelEmptyResponse, locale)
        } else {
            reply.reply_text.clone()
        };
        let _ = self.send_to_user(sender_id, &reply_text).await;

        Ok(())
    }

    async fn handle_slash_command(&self, content: &str, locale: i18n::Locale) -> String {
        let parts: Vec<&str> = content.splitn(2, ' ').collect();
        let cmd = parts[0].to_lowercase();

        match cmd.as_str() {
            "/help" => i18n::t(i18n::MsgKey::HelpWechat, locale),
            // /stop, /reset, /model now route through the session-resolve
            // path and never reach this branch. /sessions is intentionally
            // unsupported in v2.
            "/sessions" => "This command is not supported in v2 yet.".to_string(),
            _ => i18n::t(i18n::MsgKey::UnknownCommand(&cmd), locale),
        }
    }

    /// Dispatch /stop, /reset, /model against a resolved acp session id.
    async fn dispatch_session_slash_cmd(
        &self,
        lower_content: &str,
        acp_session_id: &str,
    ) -> String {
        let session = acp_session_id.to_string();
        if lower_content == "/stop" {
            return match self.acp.cancel(&session).await {
                Ok(_) => "⏹ Stopped current turn.".to_string(),
                Err(e) => format!("⚠️ Could not stop: {e}"),
            };
        }
        if lower_content == "/reset" {
            return match self.acp.reset_session(&session).await {
                Ok(_) => "🔄 Session reset. Next message starts fresh.".to_string(),
                Err(e) => format!("⚠️ Could not reset: {e}"),
            };
        }
        if lower_content == "/model" {
            return match self.acp.list_models().await {
                Ok(models) => {
                    if models.is_empty() {
                        "No models available.".to_string()
                    } else {
                        let body = models
                            .iter()
                            .map(|m| {
                                format!("• `{}/{}` — {}", m.provider, m.model, m.display_name)
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        format!(
                            "Available models:\n{body}\n\nUsage: `/model <provider>/<model>`"
                        )
                    }
                }
                Err(e) => format!("⚠️ Could not list models: {e}"),
            };
        }
        if let Some(arg) = lower_content.strip_prefix("/model ") {
            let arg = arg.trim();
            let (provider, model) = match arg.split_once('/') {
                Some((p, m)) => (p, m),
                None => ("anthropic", arg),
            };
            return match self.acp.set_model(&session, provider, model).await {
                Ok(_) => format!(
                    "✅ Switched to `{provider}/{model}`. **Note: conversation context was cleared.**"
                ),
                Err(e) => format!("⚠️ Could not switch model: {e}"),
            };
        }
        format!("Unknown command: {lower_content}")
    }
}
