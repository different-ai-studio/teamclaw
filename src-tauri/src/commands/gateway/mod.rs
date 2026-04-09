// Re-export everything from the teamclaw-gateway crate so that existing
// `crate::commands::gateway::*` paths throughout the main crate continue to work.
pub use teamclaw_gateway::*;

use std::sync::Mutex;
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

/// Get channel configuration
#[tauri::command]
pub async fn get_channel_config(
    opencode_state: State<'_, OpenCodeState>,
) -> Result<ChannelsConfig, String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
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
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
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
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

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
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;
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
    let (port, workspace_path) = {
        let inner = opencode_state.inner.lock().map_err(|e| e.to_string())?;
        let ws = inner.workspace_path.clone()
            .ok_or("No workspace path set. Please select a workspace first.")?;
        (inner.port, ws)
    };

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
        let gateway =
            gateway_guard.get_or_insert_with(|| DiscordGateway::new(port, session_mapping, workspace_path.clone()));
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
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

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
    let (port, workspace_path) = {
        let inner = opencode_state.inner.lock().map_err(|e| e.to_string())?;
        let ws = inner.workspace_path.clone()
            .ok_or("No workspace path set. Please select a workspace first.")?;
        (inner.port, ws)
    };

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
        let gateway =
            gateway_guard.get_or_insert_with(|| FeishuGateway::new(port, session_mapping, workspace_path.clone()));
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
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

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
    let (port, workspace_path) = {
        let inner = opencode_state.inner.lock().map_err(|e| e.to_string())?;
        let ws = inner.workspace_path.clone()
            .ok_or("No workspace path set. Please select a workspace first.")?;
        (inner.port, ws)
    };

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
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

    EmailGateway::gmail_authorize(&client_id, &client_secret, &email, &workspace_path).await
}

/// Check if Gmail OAuth2 tokens exist
#[tauri::command]
pub async fn check_gmail_auth(opencode_state: State<'_, OpenCodeState>) -> Result<bool, String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

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
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

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
    let (port, workspace_path) = {
        let inner = opencode_state.inner.lock().map_err(|e| e.to_string())?;
        let ws = inner.workspace_path.clone()
            .ok_or("No workspace path set. Please select a workspace first.")?;
        (inner.port, ws)
    };

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
            let gateway = KookGateway::new(port, gateway_state.shared_session_mapping.clone(), workspace_path.clone());
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
    opencode_state: State<'_, OpenCodeState>,
) -> Result<wecom_config::WeComConfig, String> {
    let channels = get_channel_config(opencode_state).await?;
    Ok(channels.wecom.unwrap_or_default())
}

/// Save WeCom configuration
#[tauri::command]
pub async fn save_wecom_config(
    wecom: wecom_config::WeComConfig,
    opencode_state: State<'_, OpenCodeState>,
    gateway_state: State<'_, GatewayState>,
) -> Result<(), String> {
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

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
    let (port, workspace_path) = {
        let inner = opencode_state.inner.lock().map_err(|e| e.to_string())?;
        let ws = inner.workspace_path.clone()
            .ok_or("No workspace path set. Please select a workspace first.")?;
        (inner.port, ws)
    };

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
        let mut guard = gateway_state
            .wecom_gateway
            .lock()
            .map_err(|e| e.to_string())?;

        if guard.is_none() {
            let gateway = WeComGateway::new(port, gateway_state.shared_session_mapping.clone(), workspace_path.clone());
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
pub async fn stop_wecom_gateway(gateway_state: State<'_, GatewayState>) -> Result<(), String> {
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
pub async fn poll_wecom_qr_auth(scode: String) -> Result<wecom_config::WeComQrAuthPollResult, String> {
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
    let workspace_path = opencode_state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .workspace_path
        .clone()
        .ok_or("No workspace path set. Please select a workspace first.")?;

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
    let (port, workspace_path) = {
        let inner = opencode_state.inner.lock().map_err(|e| e.to_string())?;
        let ws = inner.workspace_path.clone()
            .ok_or("No workspace path set. Please select a workspace first.")?;
        (inner.port, ws)
    };

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
            let gateway = WeChatGateway::new(port, gateway_state.shared_session_mapping.clone(), workspace_path.clone());
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
            if let Ok(inner) = opencode_state.inner.lock() {
                if let Some(ref workspace_path) = inner.workspace_path {
                    if let Ok(mut config) = read_config(workspace_path) {
                        let channels = config.channels.get_or_insert_with(ChannelsConfig::default);
                        channels.wechat = Some(wechat_cfg.clone());
                        let _ = write_config(workspace_path, &config);
                    }
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
