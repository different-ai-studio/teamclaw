use super::types::DeliveryChannel;
use crate::commands::gateway;
use crate::commands::gateway::email_config::EmailConfig;

/// Manages delivery of cron job results to channels.
/// Delegates to gateway modules for actual sending — no reimplementation.
/// Reads channel config from teamclaw.json on each send to pick up any changes.
#[derive(Debug, Clone)]
pub struct DeliveryManager {
    workspace_path: String,
}

impl DeliveryManager {
    pub fn new(workspace_path: String) -> Self {
        Self { workspace_path }
    }

    /// Send a notification through the specified channel.
    /// Reads fresh config from teamclaw.json each time so channel setting changes
    /// are picked up without requiring a restart.
    ///
    /// Returns `Some(message_id)` for Email (the outgoing SMTP Message-ID),
    /// or `None` for Discord/Feishu (no message-id concept needed for session tracking).
    pub async fn send_notification(
        &self,
        channel: &DeliveryChannel,
        target: &str,
        message: &str,
    ) -> Result<Option<String>, String> {
        let config = self.read_teamclaw_config()?;

        match channel {
            DeliveryChannel::Discord => {
                self.send_discord(&config, target, message).await?;
                Ok(None)
            }
            DeliveryChannel::Feishu => {
                self.send_feishu(&config, target, message).await?;
                Ok(None)
            }
            DeliveryChannel::Email => {
                let message_id = self.send_email(&config, target, message).await?;
                Ok(Some(message_id))
            }
            DeliveryChannel::Kook => {
                self.send_kook(&config, target, message).await?;
                Ok(None)
            }
            DeliveryChannel::Wechat => {
                self.send_wechat(&config, target, message).await?;
                Ok(None)
            }
            DeliveryChannel::Wecom => {
                self.send_wecom(target, message).await?;
                Ok(None)
            }
        }
    }

    /// Read the teamclaw.json config file from workspace
    fn read_teamclaw_config(&self) -> Result<serde_json::Value, String> {
        let path = format!(
            "{}/{}/{}",
            self.workspace_path,
            crate::commands::TEAMCLAW_DIR,
            crate::commands::CONFIG_FILE_NAME
        );
        let content = std::fs::read_to_string(&path).map_err(|e| {
            format!(
                "Failed to read {}: {}",
                crate::commands::CONFIG_FILE_NAME,
                e
            )
        })?;
        serde_json::from_str(&content).map_err(|e| {
            format!(
                "Failed to parse {}: {}",
                crate::commands::CONFIG_FILE_NAME,
                e
            )
        })
    }

    // ==================== Discord ====================

    /// Send via Discord — delegates to gateway::discord utilities
    async fn send_discord(
        &self,
        config: &serde_json::Value,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let token = config["channels"]["discord"]["token"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or_else(|| {
                format!(
                    "Discord bot token not configured in {}",
                    crate::commands::CONFIG_FILE_NAME
                )
            })?;

        // Determine the Discord channel ID to send to
        let channel_id = if target.starts_with("dm:") {
            let user_id = target.strip_prefix("dm:").unwrap_or(target);
            println!("[Cron Delivery] Discord DM to user: {}", user_id);
            gateway::discord::create_dm_channel(token, user_id).await?
        } else if target.starts_with("channel:") {
            let ch_id = target
                .strip_prefix("channel:")
                .unwrap_or(target)
                .to_string();
            println!("[Cron Delivery] Discord channel: {}", ch_id);
            ch_id
        } else {
            // No prefix: assume user ID, try creating DM
            println!(
                "[Cron Delivery] Discord target '{}' without prefix, trying as DM",
                target
            );
            gateway::discord::create_dm_channel(token, target).await.map_err(|e| {
                format!(
                    "Could not create DM with '{}': {}. Use 'dm:<user_id>' or 'channel:<channel_id>' format.",
                    target, e
                )
            })?
        };

        // Split message if too long (Discord limit is 2000 chars)
        let chunks = split_message(message, 2000);
        for chunk in chunks {
            gateway::discord::send_channel_message(token, &channel_id, &chunk).await?;
        }

        println!("[Cron Delivery] Discord message sent to {}", target);
        Ok(())
    }

    // ==================== Feishu ====================

    /// Send via Feishu — delegates to gateway::feishu::send_chat_message
    async fn send_feishu(
        &self,
        config: &serde_json::Value,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let app_id = config["channels"]["feishu"]["appId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                format!(
                    "Feishu app ID not configured in {}",
                    crate::commands::CONFIG_FILE_NAME
                )
            })?;
        let app_secret = config["channels"]["feishu"]["appSecret"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                format!(
                    "Feishu app secret not configured in {}",
                    crate::commands::CONFIG_FILE_NAME
                )
            })?;

        let chunks = split_message(message, 4000);
        for chunk in chunks {
            gateway::feishu::send_chat_message(app_id, app_secret, target, &chunk).await?;
        }

        println!("[Cron Delivery] Feishu message sent to {}", target);
        Ok(())
    }

    // ==================== Email ====================

    /// Send via Email — delegates to gateway::email::send_notification_email.
    /// Properly handles Gmail OAuth2 (XOAUTH2) and custom SMTP.
    /// Returns the outgoing Message-ID for session registration.
    async fn send_email(
        &self,
        config: &serde_json::Value,
        target: &str,
        message: &str,
    ) -> Result<String, String> {
        let email_val = &config["channels"]["email"];
        if email_val.is_null() {
            return Err(format!(
                "Email not configured in {}",
                crate::commands::CONFIG_FILE_NAME
            ));
        }

        // Parse into the gateway's EmailConfig type (same struct used by the email gateway)
        let email_config: EmailConfig = serde_json::from_value(email_val.clone())
            .map_err(|e| format!("Failed to parse email config: {}", e))?;

        gateway::email::send_notification_email(
            &email_config,
            &self.workspace_path,
            target,
            "[TeamClaw] Cron Job Notification",
            message,
        )
        .await
    }

    // ==================== Kook ====================

    /// Send via KOOK — delegates to gateway::kook::send_kook_message_http
    async fn send_kook(
        &self,
        config: &serde_json::Value,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let token = config["channels"]["kook"]["token"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or_else(|| {
                format!(
                    "KOOK bot token not configured in {}",
                    crate::commands::CONFIG_FILE_NAME
                )
            })?;

        let (target_id, is_dm) = if target.starts_with("dm:") {
            let user_id = target.strip_prefix("dm:").unwrap_or(target);
            println!("[Cron Delivery] KOOK DM to user: {}", user_id);
            (user_id.to_string(), true)
        } else if target.starts_with("channel:") {
            let ch_id = target
                .strip_prefix("channel:")
                .unwrap_or(target)
                .to_string();
            println!("[Cron Delivery] KOOK channel: {}", ch_id);
            (ch_id, false)
        } else {
            println!(
                "[Cron Delivery] KOOK target '{}' without prefix, trying as DM",
                target
            );
            (target.to_string(), true)
        };

        // KOOK message limit is ~8000 chars for text type
        let chunks = split_message(message, 8000);
        for chunk in chunks {
            gateway::kook::send_kook_message_http(token, &target_id, &chunk, is_dm).await?;
        }

        println!("[Cron Delivery] KOOK message sent to {}", target);
        Ok(())
    }

    // ==================== WeChat ====================

    /// Send via WeChat — delegates to gateway::wechat::send_text_message
    async fn send_wechat(
        &self,
        config: &serde_json::Value,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let bot_token = config["channels"]["wechat"]["botToken"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or("WeChat bot token not configured")?;
        let base_url = config["channels"]["wechat"]["baseUrl"]
            .as_str()
            .unwrap_or("https://ilinkai.weixin.qq.com");

        // Look up context_token from persisted config
        let context_token = config["channels"]["wechat"]["contextTokens"][target]
            .as_str()
            .ok_or_else(|| format!(
                "No context_token for WeChat user '{}'. The user must send a message to the gateway first.",
                target
            ))?;

        use crate::commands::gateway::wechat;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        wechat::send_text_message(&client, base_url, bot_token, target, message, context_token)
            .await
    }
    // ==================== WeCom ====================

    /// Send via WeCom — delegates to the running WeComGateway's send_chat_message.
    /// The gateway must be connected (WebSocket active).
    /// Target format: "single:{userid}" or "group:{chatid}" or raw "{userid}"
    async fn send_wecom(
        &self,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let (chatid, chat_type) = if target.starts_with("single:") {
            (target.strip_prefix("single:").unwrap_or(target), 1u32)
        } else if target.starts_with("group:") {
            (target.strip_prefix("group:").unwrap_or(target), 2u32)
        } else {
            // Raw value without prefix — default to single chat
            (target, 1u32)
        };

        let chunks = split_message(message, 4000);
        for chunk in chunks {
            gateway::wecom::send_proactive_message(chatid, chat_type, &chunk).await?;
        }

        println!("[Cron Delivery] WeCom message sent to {} (chat_type={})", chatid, chat_type);
        Ok(())
    }
}

/// Split a message into chunks, respecting UTF-8 character boundaries.
/// `max_len` is measured in bytes.
fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        // Find a safe byte boundary at or before max_len
        let mut split_at = max_len;
        // Walk backwards to a valid UTF-8 char boundary
        while split_at > 0 && !remaining.is_char_boundary(split_at) {
            split_at -= 1;
        }

        // Try to split at a newline within the safe range
        let actual_split = remaining[..split_at].rfind('\n').unwrap_or_else(|| {
            // Try to split at a space
            remaining[..split_at].rfind(' ').unwrap_or(split_at)
        });

        if actual_split == 0 {
            // Edge case: no good split point found, force split at char boundary
            chunks.push(remaining[..split_at].to_string());
            remaining = &remaining[split_at..];
        } else {
            chunks.push(remaining[..actual_split].to_string());
            remaining = remaining[actual_split..].trim_start();
        }
    }

    chunks
}
