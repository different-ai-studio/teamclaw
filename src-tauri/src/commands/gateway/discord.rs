use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serenity::all::{
    async_trait, Client, Context, EventHandler, GatewayIntents, Message, Ready,
    Http, Interaction, Command, CreateCommand, CreateCommandOption, CommandOptionType,
    CreateInteractionResponse, CreateInteractionResponseMessage, EditInteractionResponse, EditMessage,
};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock, oneshot};

use super::config::{DiscordConfig, GatewayStatus, GatewayStatusResponse};
use super::session::SessionMapping;

use super::{FilterResult, ProcessedMessageTracker, MAX_PROCESSED_MESSAGES};

/// Discord bot handler
pub struct DiscordHandler {
    config: Arc<RwLock<DiscordConfig>>,
    session_mapping: SessionMapping,
    opencode_port: u16,
    status_tx: mpsc::Sender<GatewayStatusResponse>,
    bot_user_id: Arc<RwLock<Option<u64>>>,
    /// Tracker for processed message IDs to prevent duplicate processing
    processed_messages: Arc<RwLock<ProcessedMessageTracker>>,
    /// Permission auto-approver
    #[allow(dead_code)]
    permission_approver: super::PermissionAutoApprover,
    /// Pending question store for question forwarding
    pending_questions: Arc<super::PendingQuestionStore>,
}

impl DiscordHandler {
    pub fn new(
        config: Arc<RwLock<DiscordConfig>>,
        session_mapping: SessionMapping,
        opencode_port: u16,
        status_tx: mpsc::Sender<GatewayStatusResponse>,
        permission_approver: super::PermissionAutoApprover,
        pending_questions: Arc<super::PendingQuestionStore>,
    ) -> Self {
        Self {
            config,
            session_mapping,
            opencode_port,
            status_tx,
            bot_user_id: Arc::new(RwLock::new(None)),
            processed_messages: Arc::new(RwLock::new(ProcessedMessageTracker::new(MAX_PROCESSED_MESSAGES))),
            permission_approver,
            pending_questions,
        }
    }

    /// Check if a message has already been processed, and mark it as processed if not
    async fn mark_message_processed(&self, message_id: u64) -> bool {
        let mut tracker = self.processed_messages.write().await;
        tracker.is_duplicate(&message_id.to_string())
    }

    /// Check if a message should be processed based on config
    async fn should_process_message(&self, msg: &Message, ctx: &Context) -> FilterResult {
        // Ignore bot messages
        if msg.author.bot {
            return FilterResult::Ignore;
        }

        let config = self.config.read().await;

        // Check if it's a DM
        if msg.guild_id.is_none() {
            return self.check_dm_allowed(&config, &msg.author.id.to_string()).await;
        }

        // It's a guild message
        let guild_id = msg.guild_id.unwrap().to_string();
        let channel_id = msg.channel_id.to_string();

        self.check_guild_allowed(&config, &guild_id, &channel_id, msg, ctx).await
    }

    /// Check if DM is allowed for this user
    async fn check_dm_allowed(&self, config: &DiscordConfig, user_id: &str) -> FilterResult {
        if !config.dm.enabled {
            return FilterResult::Ignore;
        }

        match config.dm.policy.as_str() {
            "open" => FilterResult::Allow,
            "allowlist" => {
                if config.dm.allow_from.contains(&user_id.to_string())
                    || config.dm.allow_from.contains(&"*".to_string()) {
                    FilterResult::Allow
                } else {
                    FilterResult::UserNotAllowed
                }
            }
            _ => FilterResult::Allow,
        }
    }

    /// Check if guild/channel message is allowed
    async fn check_guild_allowed(
        &self,
        config: &DiscordConfig,
        guild_id: &str,
        channel_id: &str,
        msg: &Message,
        _ctx: &Context,
    ) -> FilterResult {
        println!("[Discord] check_guild_allowed: guild_id={}, channel_id={}", guild_id, channel_id);
        println!("[Discord] Available guilds in config: {:?}", config.guilds.keys().collect::<Vec<_>>());
        
        // Check wildcard guild config first
        let guild_config = config
            .guilds
            .get(guild_id)
            .or_else(|| config.guilds.get("*"));

        let guild_config = match guild_config {
            Some(c) => {
                println!("[Discord] Found guild config");
                c
            },
            None => {
                println!("[Discord] No guild config found for {}", guild_id);
                return FilterResult::ChannelNotConfigured;
            }
        };

        // Check if user is in guild allowlist (if specified)
        if !guild_config.users.is_empty() {
            let user_id = msg.author.id.to_string();
            println!("[Discord] Checking user {} against allowlist: {:?}", user_id, guild_config.users);
            if !guild_config.users.contains(&user_id) && !guild_config.users.contains(&"*".to_string()) {
                println!("[Discord] User not in allowlist");
                return FilterResult::UserNotAllowed;
            }
        }

        // Check channel config
        println!("[Discord] Available channels in config: {:?}", guild_config.channels.keys().collect::<Vec<_>>());
        let channel_config = guild_config
            .channels
            .get(channel_id)
            .or_else(|| guild_config.channels.get("*"));

        let (allow, require_mention) = match channel_config {
            Some(c) => {
                println!("[Discord] Found channel config: allow={}", c.allow);
                (c.allow, c.require_mention.unwrap_or(guild_config.require_mention))
            },
            None => {
                println!("[Discord] No channel config found");
                // If no channel config and guild has channels specified, deny
                if !guild_config.channels.is_empty() {
                    println!("[Discord] Guild has channels but none match, denying");
                    return FilterResult::ChannelNotConfigured;
                }
                // Use guild-level require_mention
                (true, guild_config.require_mention)
            }
        };

        if !allow {
            println!("[Discord] Channel not allowed");
            return FilterResult::ChannelNotConfigured;
        }

        // Check if mention is required
        if require_mention {
            let bot_id = self.bot_user_id.read().await;
            if let Some(id) = *bot_id {
                let mentioned = msg.mentions_user_id(id);
                println!("[Discord] Require mention: bot_id={}, mentioned={}", id, mentioned);
                if mentioned {
                    return FilterResult::Allow;
                } else {
                    return FilterResult::Ignore;
                }
            }
            println!("[Discord] Require mention but no bot_id");
            return FilterResult::Ignore;
        }

        println!("[Discord] Message allowed");
        FilterResult::Allow
    }

    /// Process a message and send to OpenCode
    async fn process_message(&self, msg: &Message, ctx: &Context) {
        println!("[Discord] process_message called, opencode_port: {}", self.opencode_port);
        let _config = self.config.read().await;
        let is_dm = msg.guild_id.is_none();
        println!("[Discord] is_dm: {}", is_dm);

        // Clean message content first (remove bot mention if present)
        let mut content = msg.content.clone();
        let bot_id = self.bot_user_id.read().await;
        if let Some(id) = *bot_id {
            content = content
                .replace(&format!("<@{}>", id), "")
                .replace(&format!("<@!{}>", id), "")
                .trim()
                .to_string();
        }
        drop(bot_id);

        // Check if message has any content (text or images)
        let has_images = msg.attachments
            .iter()
            .any(|a| a.content_type.as_ref().map(|ct| ct.starts_with("image/")).unwrap_or(false));
        
        if content.is_empty() && !has_images {
            return;
        }

        // Build session key for this context (used for session ID, model preference, and commands)
        let session_key = if is_dm {
            format!("discord:dm:{}", msg.author.id)
        } else {
            format!("discord:channel:{}:{}", msg.guild_id.unwrap(), msg.channel_id)
        };

        // Handle /model command before creating session
        if content.eq_ignore_ascii_case("/model") || content.to_lowercase().starts_with("/model ") {
            let arg = if content.len() > 7 { content[7..].trim() } else { "" };
            println!("[Discord] Model command received, arg: '{}'", arg);
            let response = super::handle_model_command(
                self.opencode_port, &self.session_mapping, &session_key, arg,
            ).await;

            // Split response if too long
            let chunks = split_message(&response, 2000);
            let mut is_first = true;
            for chunk in chunks {
                let result = if is_first {
                    is_first = false;
                    msg.reply(&ctx.http, &chunk).await
                } else {
                    msg.channel_id.say(&ctx.http, &chunk).await
                };
                if let Err(e) = result {
                    eprintln!("[Discord] Failed to send model response: {}", e);
                }
            }
            return;
        }

        // Handle /reset command before creating session
        if content.eq_ignore_ascii_case("/reset") {
            println!("[Discord] Reset command received");
            self.session_mapping.remove_session(&session_key).await;
            let reply_text = if is_dm {
                "Session reset. A new session will be created for your next message."
            } else {
                "Channel session reset. A new session will be created for the next message."
            };
            let _ = msg.reply(&ctx.http, reply_text).await;
            println!("[Discord] Session reset completed");
            return;
        }

        // Handle /stop command
        if content.eq_ignore_ascii_case("/stop") {
            println!("[Discord] Stop command received");
            let response = super::handle_stop_command(
                self.opencode_port, &self.session_mapping, &session_key,
            ).await;
            let _ = msg.reply(&ctx.http, &response).await;
            return;
        }

        // Handle /sessions command (send placeholder first, then edit with result)
        if content.eq_ignore_ascii_case("/sessions") || content.to_lowercase().starts_with("/sessions ") {
            let arg = if content.len() > 10 { content[10..].trim() } else { "" };
            println!("[Discord] Sessions command received, arg: '{}'", arg);

            // Send a placeholder message first
            let placeholder = msg.reply(&ctx.http, "Loading sessions...").await;
            let response = super::handle_sessions_command(
                self.opencode_port, &self.session_mapping, &session_key, arg,
            ).await;

            // Edit the placeholder with the actual response
            if let Ok(mut reply_msg) = placeholder {
                let chunks = split_message(&response, 2000);
                let first_chunk = chunks.first().cloned().unwrap_or_default();
                let _ = reply_msg.edit(&ctx.http, EditMessage::new().content(&first_chunk)).await;
                // Send remaining chunks as new messages
                for chunk in chunks.iter().skip(1) {
                    let _ = msg.channel_id.say(&ctx.http, chunk).await;
                }
            }
            return;
        }

        let session_id = match self.session_mapping.get_session(&session_key).await {
            Some(id) => id,
            None => {
                match self.create_opencode_session().await {
                    Ok(id) => {
                        self.session_mapping
                            .set_session(session_key.clone(), id.clone())
                            .await;
                        id
                    }
                    Err(e) => {
                        let _ = msg
                            .reply(&ctx.http, format!("Error creating session: {}", e))
                            .await;
                        return;
                    }
                }
            }
        };

        // Extract images from attachments: (url, mime_type)
        let images: Vec<(String, String)> = msg.attachments
            .iter()
            .filter_map(|a| {
                a.content_type.as_ref().and_then(|ct| {
                    if ct.starts_with("image/") {
                        Some((a.url.clone(), ct.clone()))
                    } else {
                        None
                    }
                })
            })
            .collect();
        
        if !images.is_empty() {
            println!("[Discord] Found {} image(s) in message", images.len());
            for (url, mime) in &images {
                println!("[Discord]   - {} ({})", url, mime);
            }
        }

        // Look up model preference for this context
        let model_param = self
            .session_mapping
            .get_model(&session_key)
            .await
            .and_then(|m| super::parse_model_preference(&m));

        // Send immediate "Thinking..." reply so the user knows the bot is processing
        let processing_msg = msg.reply(&ctx.http, "🤔 Thinking...").await.ok();

        // Send typing indicator
        let typing = msg.channel_id.start_typing(&ctx.http);

        // Build question context for forwarding AI questions to Discord
        let pending_questions = Arc::clone(&self.pending_questions);
        let channel_id = msg.channel_id;
        let http = Arc::clone(&ctx.http);
        let question_ctx = super::QuestionContext {
            forwarder: Box::new(move |fq: super::ForwardedQuestion| {
                let http = Arc::clone(&http);
                Box::pin(async move {
                    let text = super::format_question_message(&fq.questions, &fq.question_id);
                    let sent = channel_id.say(&http, &text).await
                        .map_err(|e| format!("Failed to send question: {}", e))?;
                    Ok(sent.id.to_string())
                })
            }),
            store: pending_questions,
        };

        // Send message to OpenCode (with automatic permission approval)
        let result = self.send_to_opencode(&session_id, &content, images.clone(), model_param.clone(), Some(question_ctx)).await;

        match result {
            Ok(response) => {
                // Split response if too long (Discord limit is 2000 chars)
                let chunks = split_message(&response, 2000);
                if let Some(mut proc_msg) = processing_msg {
                    // Edit the "Thinking..." message with the first chunk
                    let edit = EditMessage::new().content(&chunks[0]);
                    let _ = proc_msg.edit(&ctx.http, edit).await;
                    // Send remaining chunks as new messages
                    for chunk in chunks.iter().skip(1) {
                        if let Err(e) = msg.channel_id.say(&ctx.http, chunk).await {
                            eprintln!("Failed to send Discord message: {}", e);
                        }
                    }
                } else {
                    // Fallback: send as new messages if processing message failed
                    let mut is_first = true;
                    for chunk in chunks {
                        let result = if is_first {
                            is_first = false;
                            msg.reply(&ctx.http, &chunk).await
                        } else {
                            msg.channel_id.say(&ctx.http, &chunk).await
                        };
                        if let Err(e) = result {
                            eprintln!("Failed to send Discord message: {}", e);
                        }
                    }
                }
            }
            Err(e) => {
                // Edit the "Thinking..." message with the error, or send a new reply
                if let Some(mut proc_msg) = processing_msg {
                    let edit = EditMessage::new().content(format!("❌ Error: {}", e));
                    let _ = proc_msg.edit(&ctx.http, edit).await;
                } else {
                    let _ = msg
                        .reply(&ctx.http, format!("Error processing message: {}", e))
                        .await;
                }
            }
        }

        drop(typing);
    }

    /// Create a new OpenCode session
    async fn create_opencode_session(&self) -> Result<String, String> {
        super::create_opencode_session(self.opencode_port).await
    }

    /// Send a message to OpenCode using async mode with permission auto-approval
    /// images: Vec<(url, mime_type)>
    /// model: Optional (providerID, modelID) to override the model for this request
    async fn send_to_opencode(
        &self,
        session_id: &str,
        content: &str,
        images: Vec<(String, String)>,
        model: Option<(String, String)>,
        question_ctx: Option<super::QuestionContext>,
    ) -> Result<String, String> {
        // Download client for images (short timeout)
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to create client: {}", e))?;
        
        let url = format!(
            "http://127.0.0.1:{}/session/{}/message",
            self.opencode_port, session_id
        );
        println!("[Discord] Sending to OpenCode: {} content: {}, images: {}", 
            url, content, images.len());

        // Build parts array with text and images
        let mut parts = Vec::new();
        
        // Add text part if not empty
        if !content.is_empty() {
            parts.push(serde_json::json!({
                "type": "text",
                "text": content
            }));
        }
        
        // Add image parts as "file" type with data URI (download and convert to base64)
        for (image_url, mime_type) in &images {
            println!("[Discord] Downloading image: {}", image_url);
            
            // Download image
            let img_response = client
                .get(image_url)
                .send()
                .await
                .map_err(|e| format!("Failed to download image: {}", e))?;
            
            if !img_response.status().is_success() {
                println!("[Discord] Failed to download image: HTTP {}", img_response.status());
                continue;
            }
            
            let img_bytes = img_response
                .bytes()
                .await
                .map_err(|e| format!("Failed to read image bytes: {}", e))?;
            
            // Convert to base64 data URI
            let base64_data = BASE64.encode(&img_bytes);
            let data_uri = format!("data:{};base64,{}", mime_type, base64_data);
            
            println!("[Discord] Image converted to base64: {} bytes -> {} chars", 
                img_bytes.len(), data_uri.len());
            
            parts.push(serde_json::json!({
                "type": "file",
                "url": data_uri,
                "mime": mime_type
            }));
        }
        
        // If no parts, add empty text
        if parts.is_empty() {
            parts.push(serde_json::json!({
                "type": "text",
                "text": ""
            }));
        }

        println!("[Discord] Sending message asynchronously with permission auto-approval");
        
        // Use async send with permission auto-approval
        super::send_message_async_with_approval(
            self.opencode_port,
            session_id,
            parts,
            model,
            question_ctx,
        ).await
    }

    /// Update gateway status
    async fn update_status(&self, status: GatewayStatusResponse) {
        let _ = self.status_tx.send(status).await;
    }
}

#[async_trait]
impl EventHandler for DiscordHandler {
    async fn message(&self, ctx: Context, msg: Message) {
        let message_id = msg.id.get();
        println!("[Discord] Received message {} from {}: {}", message_id, msg.author.name, msg.content);
        
        // Check for duplicate message processing
        if self.mark_message_processed(message_id).await {
            println!("[Discord] Message {} already processed, skipping", message_id);
            return;
        }

        // Check if this is a reply to a pending question
        if let Some(ref referenced) = msg.referenced_message {
            let ref_id = referenced.id.to_string();
            if let Some(entry) = self.pending_questions.take(&ref_id).await {
                let answer_text = msg.content.clone();
                let _ = entry.answer_tx.send(answer_text);
                println!("[Discord] Question {} answered via reply", entry.question_id);
                return;
            }
        }

        let filter_result = self.should_process_message(&msg, &ctx).await;
        println!("[Discord] Filter result: {:?}, guild_id: {:?}, channel_id: {}", 
            filter_result, msg.guild_id, msg.channel_id);
        
        match filter_result {
            FilterResult::Allow => {
                println!("[Discord] Processing message {}...", message_id);
                self.process_message(&msg, &ctx).await;
                println!("[Discord] Message {} processed", message_id);
            }
            FilterResult::UserNotAllowed => {
                println!("[Discord] User not in whitelist, sending rejection");
                let _ = msg.reply(
                    &ctx.http, 
                    "Sorry, you are not authorized to use this bot. Please contact the administrator to request access."
                ).await;
            }
            FilterResult::ChannelNotConfigured => {
                println!("[Discord] Channel not configured, sending hint");
                let _ = msg.reply(
                    &ctx.http, 
                    "This channel is not configured for the bot. Please ask the administrator to add this server/channel in TeamClaw settings."
                ).await;
            }
            FilterResult::Ignore => {
                println!("[Discord] Message filtered out (silent)");
            }
        }
    }

    async fn ready(&self, ctx: Context, ready: Ready) {
        println!("Discord bot connected as {}", ready.user.name);

        // Store bot user ID
        {
            let mut bot_id = self.bot_user_id.write().await;
            *bot_id = Some(ready.user.id.get());
        }

        // Register global slash commands
        println!("[Discord] Registering slash commands...");
        let commands = vec![
            CreateCommand::new("reset")
                .description("Reset the current chat session with the AI"),
            CreateCommand::new("model")
                .description("View current model or switch to a different model")
                .add_option(
                    CreateCommandOption::new(
                        CommandOptionType::String,
                        "name",
                        "Model to switch to (format: provider/model)",
                    )
                    .required(false),
                ),
            CreateCommand::new("stop")
                .description("Stop the current session's processing"),
            CreateCommand::new("sessions")
                .description("List recent sessions or switch to a session by number")
                .add_option(
                    CreateCommandOption::new(
                        CommandOptionType::Integer,
                        "number",
                        "Session number to switch to (from the list)",
                    )
                    .required(false),
                ),
            CreateCommand::new("help")
                .description("Show available commands and how to use the bot"),
        ];

        match Command::set_global_commands(&ctx.http, commands).await {
            Ok(cmds) => {
                println!("[Discord] Registered {} slash commands: {:?}", 
                    cmds.len(), 
                    cmds.iter().map(|c| &c.name).collect::<Vec<_>>()
                );
            }
            Err(e) => {
                println!("[Discord] Failed to register slash commands: {}", e);
            }
        }

        // Update status
        let guilds: Vec<String> = ready
            .guilds
            .iter()
            .map(|g| g.id.to_string())
            .collect();

        self.update_status(GatewayStatusResponse {
            status: GatewayStatus::Connected,
            discord_connected: true,
            error_message: None,
            connected_guilds: guilds,
            bot_username: Some(ready.user.name.clone()),
        })
        .await;
    }

    async fn interaction_create(&self, ctx: Context, interaction: Interaction) {
        if let Interaction::Command(command) = interaction {
            println!("[Discord] Received slash command: {}", command.data.name);

            // Defer the response first to avoid the 3-second timeout.
            // This shows "Bot is thinking..." to the user.
            let defer = CreateInteractionResponse::Defer(
                CreateInteractionResponseMessage::new().ephemeral(true)
            );
            if let Err(e) = command.create_response(&ctx.http, defer).await {
                println!("[Discord] Failed to defer slash command: {}", e);
                return;
            }

            let content = match command.data.name.as_str() {
                "reset" => {
                    let is_dm = command.guild_id.is_none();
                    let session_key = if is_dm {
                        format!("discord:dm:{}", command.user.id)
                    } else {
                        format!("discord:channel:{}:{}", command.guild_id.unwrap(), command.channel_id)
                    };
                    self.session_mapping.remove_session(&session_key).await;
                    if is_dm {
                        "Session reset! A new conversation will start with your next message.".to_string()
                    } else {
                        "Channel session reset! A new conversation will start with the next message.".to_string()
                    }
                }
                "model" => {
                    let model_arg = command
                        .data
                        .options
                        .iter()
                        .find(|o| o.name == "name")
                        .and_then(|o| o.value.as_str())
                        .unwrap_or("");

                    let is_dm = command.guild_id.is_none();
                    let session_key = if is_dm {
                        format!("discord:dm:{}", command.user.id)
                    } else {
                        format!("discord:channel:{}:{}", command.guild_id.unwrap(), command.channel_id)
                    };

                    super::handle_model_command(
                        self.opencode_port, &self.session_mapping, &session_key, model_arg,
                    ).await
                }
                "stop" => {
                    let is_dm = command.guild_id.is_none();
                    let session_key = if is_dm {
                        format!("discord:dm:{}", command.user.id)
                    } else {
                        format!("discord:channel:{}:{}", command.guild_id.unwrap(), command.channel_id)
                    };

                    super::handle_stop_command(
                        self.opencode_port, &self.session_mapping, &session_key,
                    ).await
                }
                "sessions" => {
                    let session_arg = command
                        .data
                        .options
                        .iter()
                        .find(|o| o.name == "number")
                        .and_then(|o| o.value.as_i64())
                        .map(|n| n.to_string())
                        .unwrap_or_default();

                    let is_dm = command.guild_id.is_none();
                    let session_key = if is_dm {
                        format!("discord:dm:{}", command.user.id)
                    } else {
                        format!("discord:channel:{}:{}", command.guild_id.unwrap(), command.channel_id)
                    };

                    super::handle_sessions_command(
                        self.opencode_port, &self.session_mapping, &session_key, &session_arg,
                    ).await
                }
                "help" => {
                    "**TeamClaw Bot Commands**\n\n\
                    `/reset` - Reset the current chat session\n\
                    `/model` - View current model or switch models\n\
                    `/sessions` - List or switch sessions\n\
                    `/stop` - Stop the current processing\n\
                    `/help` - Show this help message\n\n\
                    **How to use:**\n\
                    • In DMs: Just send a message to start chatting\n\
                    • In channels: Mention the bot or reply to its messages\n\n\
                    You can also send images along with your messages!".to_string()
                }
                _ => "Unknown command".to_string(),
            };

            // Edit the deferred response with the actual content
            let edit = EditInteractionResponse::new().content(content);
            if let Err(e) = command.edit_response(&ctx.http, edit).await {
                println!("[Discord] Failed to edit slash command response: {}", e);
            }
        }
    }
}

/// Split a message into chunks that fit Discord's limit
fn split_message(content: &str, max_len: usize) -> Vec<String> {
    if content.len() <= max_len {
        return vec![content.to_string()];
    }

    let mut chunks = Vec::new();
    let mut current = String::new();

    for line in content.lines() {
        if current.len() + line.len() + 1 > max_len {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            // If single line is too long, split it
            if line.len() > max_len {
                let mut remaining = line;
                while remaining.len() > max_len {
                    let (chunk, rest) = remaining.split_at(max_len);
                    chunks.push(chunk.to_string());
                    remaining = rest;
                }
                current = remaining.to_string();
            } else {
                current = line.to_string();
            }
        } else {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(line);
        }
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

/// Discord gateway manager
pub struct DiscordGateway {
    config: Arc<RwLock<DiscordConfig>>,
    session_mapping: SessionMapping,
    opencode_port: u16,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<GatewayStatusResponse>>,
    /// Track if gateway is currently running
    is_running: Arc<RwLock<bool>>,
    /// Permission auto-approver
    permission_approver: super::PermissionAutoApprover,
    /// Pending question store for question forwarding
    pending_questions: Arc<super::PendingQuestionStore>,
}

impl DiscordGateway {
    pub fn new(opencode_port: u16, session_mapping: SessionMapping) -> Self {
        Self {
            config: Arc::new(RwLock::new(DiscordConfig::default())),
            session_mapping,
            opencode_port,
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(GatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            permission_approver: super::PermissionAutoApprover::new(opencode_port),
            pending_questions: Arc::new(super::PendingQuestionStore::new()),
        }
    }

    /// Update the configuration
    pub async fn set_config(&self, config: DiscordConfig) {
        let mut cfg = self.config.write().await;
        *cfg = config;
    }

    /// Get current configuration
    #[allow(dead_code)]
    pub async fn get_config(&self) -> DiscordConfig {
        self.config.read().await.clone()
    }

    /// Get current status
    pub async fn get_status(&self) -> GatewayStatusResponse {
        self.status.read().await.clone()
    }

    /// Start the Discord bot
    pub async fn start(&self) -> Result<(), String> {
        let config = self.config.read().await.clone();

        if !config.enabled {
            return Err("Discord is not enabled".to_string());
        }

        if config.token.is_empty() {
            return Err("Discord bot token is not configured".to_string());
        }

        // Check if already running using is_running flag
        {
            let mut is_running = self.is_running.write().await;
            if *is_running {
                return Err("Discord gateway is already running".to_string());
            }
            // Mark as running immediately to prevent race conditions
            *is_running = true;
        }

        // Update status to connecting
        {
            let mut status = self.status.write().await;
            status.status = GatewayStatus::Connecting;
        }

        // Create status channel
        let (status_tx, mut status_rx) = mpsc::channel::<GatewayStatusResponse>(10);
        let status_clone = Arc::clone(&self.status);

        // Spawn status updater
        tokio::spawn(async move {
            while let Some(new_status) = status_rx.recv().await {
                let mut status = status_clone.write().await;
                *status = new_status;
            }
        });

        // Create handler
        let handler = DiscordHandler::new(
            Arc::clone(&self.config),
            self.session_mapping.clone(),
            self.opencode_port,
            status_tx,
            self.permission_approver.clone(),
            Arc::clone(&self.pending_questions),
        );

        // Build client
        let intents = GatewayIntents::GUILD_MESSAGES
            | GatewayIntents::DIRECT_MESSAGES
            | GatewayIntents::MESSAGE_CONTENT;

        let mut client = Client::builder(&config.token, intents)
            .event_handler(handler)
            .await
            .map_err(|e| format!("Failed to create Discord client: {}", e))?;

        // Create shutdown channel
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
        {
            let mut tx = self.shutdown_tx.write().await;
            *tx = Some(shutdown_tx);
        }

        let status_clone = Arc::clone(&self.status);
        let is_running_clone = Arc::clone(&self.is_running);

        // Clone shard_manager so we can shut down the websocket properly
        let shard_manager = client.shard_manager.clone();

        // Spawn the client
        tokio::spawn(async move {
            tokio::select! {
                result = client.start() => {
                    if let Err(e) = result {
                        eprintln!("Discord client error: {}", e);
                        let mut status = status_clone.write().await;
                        *status = GatewayStatusResponse {
                            status: GatewayStatus::Error,
                            discord_connected: false,
                            error_message: Some(e.to_string()),
                            connected_guilds: Vec::new(),
                            bot_username: None,
                        };
                    }
                }
                _ = &mut shutdown_rx => {
                    println!("[Discord] Gateway shutdown requested, closing shards...");
                    shard_manager.shutdown_all().await;
                    println!("[Discord] All shards shut down");
                    let mut status = status_clone.write().await;
                    *status = GatewayStatusResponse::default();
                }
            }
            // Mark as not running when client stops
            let mut is_running = is_running_clone.write().await;
            *is_running = false;
            println!("[Discord] Gateway stopped, is_running set to false");
        });

        Ok(())
    }

    /// Stop the Discord bot
    pub async fn stop(&self) -> Result<(), String> {
        // Check if running
        let running = *self.is_running.read().await;
        if !running {
            return Err("Discord gateway is not running".to_string());
        }
        
        let mut shutdown = self.shutdown_tx.write().await;
        if let Some(tx) = shutdown.take() {
            let _ = tx.send(());
            
            // Wait for the spawned task to finish (is_running becomes false)
            for _ in 0..50 {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                if !*self.is_running.read().await {
                    break;
                }
            }
            
            // Force reset state in case the wait timed out
            {
                let mut is_running = self.is_running.write().await;
                *is_running = false;
            }
            {
                let mut status = self.status.write().await;
                *status = GatewayStatusResponse::default();
            }
            
            // Clear only Discord sessions
            self.session_mapping.clear_by_namespace("discord").await;
            
            println!("[Discord] Gateway fully stopped");
            Ok(())
        } else {
            // Shouldn't happen, but reset state anyway
            let mut is_running = self.is_running.write().await;
            *is_running = false;
            Err("Discord gateway shutdown channel not found".to_string())
        }
    }

    /// Test if a token is valid
    pub async fn test_token(token: &str) -> Result<String, String> {
        let http = Http::new(token);
        
        match http.get_current_user().await {
            Ok(user) => {
                // In newer Discord API, discriminator may be None (for users with new username system)
                match user.discriminator {
                    Some(d) => Ok(format!("{}#{:04}", user.name, d)),
                    None => Ok(user.name.to_string()),
                }
            }
            Err(e) => Err(format!("Invalid token: {}", e)),
        }
    }
}

impl Clone for DiscordGateway {
    fn clone(&self) -> Self {
        Self {
            config: Arc::clone(&self.config),
            session_mapping: self.session_mapping.clone(),
            opencode_port: self.opencode_port,
            shutdown_tx: Arc::clone(&self.shutdown_tx),
            status: Arc::clone(&self.status),
            is_running: Arc::clone(&self.is_running),
            permission_approver: self.permission_approver.clone(),
            pending_questions: Arc::clone(&self.pending_questions),
        }
    }
}

// ==================== Reusable Send Utilities ====================
// Standalone functions for sending Discord messages via REST API.
// Used by both the gateway handler and cron delivery.

/// Send a message to a Discord channel via REST API.
pub async fn send_channel_message(token: &str, channel_id: &str, content: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("https://discord.com/api/v10/channels/{}/messages", channel_id);
    let body = serde_json::json!({ "content": content });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bot {}", token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Discord API error: {}", e))?;

    if !response.status().is_success() {
        let err = response.text().await.unwrap_or_default();
        return Err(format!("Discord send failed: {}", err));
    }
    Ok(())
}

/// Create a DM channel with a Discord user. Returns the DM channel ID.
pub async fn create_dm_channel(token: &str, user_id: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = "https://discord.com/api/v10/users/@me/channels";
    let body = serde_json::json!({ "recipient_id": user_id });

    let response = client
        .post(url)
        .header("Authorization", format!("Bot {}", token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to create DM channel: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let err = response.text().await.unwrap_or_default();
        return Err(format!("Failed to create DM (HTTP {}): {}", status, err));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse DM response: {}", e))?;

    data["id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "No channel ID in DM response".to_string())
}
