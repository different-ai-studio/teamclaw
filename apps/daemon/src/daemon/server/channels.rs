//! Extracted from `server.rs` — methods of `DaemonServer` grouped by concern.
//! See `server.rs` for the struct definition and core lifecycle.

use super::*;

impl DaemonServer {
    /// Build a `ChannelManager` from the given config and call
    /// `start_enabled()`. Returns `None` when the daemon has no `team_id`
    /// yet (not onboarded) — caller logs and skips. Per-channel start
    /// failures are logged inside `start_enabled` and do NOT abort the
    /// whole boot.
    pub(crate) async fn build_and_start_channel_manager(
        &self,
        cfg: DaemonConfig,
    ) -> Option<ChannelManager> {
        let Some(team_id) = cfg.team_id.clone() else {
            info!("channels: daemon has no team_id (run `amuxd init`); skipping channel start");
            return None;
        };

        // The daemon's own actor_id (persisted in backend.toml during `init`)
        // is the agent participant the gateway-port channels speak as. Admin
        // owners are looked up from agent_member_access so they appear in
        // session_participants and can see gateway-originated DMs via RLS.
        let primary_agent_actor_id = self.actor_id.clone();
        let agent_owner_actor_ids: Vec<String> = match self
            .backend
            .list_agent_admin_member_actor_ids(&primary_agent_actor_id)
            .await
        {
            Ok(ids) => {
                tracing::info!(
                    "channel manager: {} admin owner(s) found for agent {}",
                    ids.len(),
                    primary_agent_actor_id
                );
                ids
            }
            Err(e) => {
                tracing::error!(
                    "channel manager: failed to resolve agent owners: {:?}; continuing with empty owner list",
                    e
                );
                Vec::new()
            }
        };

        // Resolve the daemon agent's own configured defaults so gateway
        // (WeCom/etc.) sessions spawn on its default agent type + default
        // workspace instead of the daemon-wide fallback type and a /tmp scratch
        // dir. Best-effort: a fetch failure or unset defaults degrades to the
        // prior behavior rather than blocking channel startup.
        let (default_agent_type, default_workspace_dir) = match self
            .backend
            .get_agent_defaults(&primary_agent_actor_id)
            .await
        {
            Ok(defaults) => {
                let agent_type = defaults
                    .default_agent_type
                    .as_deref()
                    .and_then(agent_type_from_name);
                let workspace_dir = match defaults.default_workspace_id.as_deref() {
                    Some(id) => {
                        let path = self.workspace_resolver.resolve(id).await.ok().map(|w| w.path);
                        if path.is_none() {
                            warn!(
                                workspace_id = %id,
                                "channel manager: agent default workspace could not be resolved; \
                                 gateway sessions fall back to a scratch dir"
                            );
                        }
                        path
                    }
                    None => None,
                };
                info!(
                    ?agent_type,
                    workspace_dir = ?workspace_dir,
                    "channel manager: resolved gateway agent defaults"
                );
                (agent_type, workspace_dir)
            }
            Err(e) => {
                warn!(
                    "channel manager: failed to fetch agent defaults: {e:?}; \
                     gateway sessions use daemon-wide defaults"
                );
                (None, None)
            }
        };

        // Per-bot runtime registry: resolve each WeCom bot's workspace dir +
        // agent type from `daemon.toml` so a bot's sessions spawn on its own
        // workspace/agent instead of the daemon-wide gateway defaults. Bots not
        // listed here (or with unresolved overrides) fall back to the defaults.
        let bot_configs: std::collections::HashMap<String, crate::channels::BotRuntimeConfig> = {
            use crate::channels::BotRuntimeConfig;
            let mut m = std::collections::HashMap::new();
            if let Some(wecom) = &cfg.channels.wecom {
                for bot in wecom.resolved_bots() {
                    let workspace_dir = match bot.workspace_id.as_deref() {
                        Some(id) => {
                            let path = self.workspace_resolver.resolve(id).await.ok().map(|w| w.path);
                            if path.is_none() {
                                warn!(
                                    bot_id = %bot.bot_id,
                                    workspace_id = %id,
                                    "wecom bot workspace could not be resolved; \
                                     its sessions fall back to the daemon default workspace"
                                );
                            }
                            path
                        }
                        None => None,
                    };
                    let agent_type = bot.agent_type.as_deref().and_then(agent_type_from_name);
                    m.insert(
                        bot.bot_id.clone(),
                        BotRuntimeConfig {
                            workspace_dir,
                            agent_type,
                            system_prompt: bot.system_prompt.clone(),
                        },
                    );
                }
            }
            m
        };

        let acp_handle: Arc<dyn AcpHandle> = Arc::new(AmuxdAcpHandle {
            manager: self.agents.clone(),
            logical_to_acp: Arc::new(AsyncMutex::new(HashMap::new())),
            team_id: team_id.clone(),
            model_override: Arc::new(AsyncMutex::new(HashMap::new())),
            backend: self.backend.clone(),
            default_agent_type,
            default_workspace_dir,
            agent_type_override: Arc::new(AsyncMutex::new(HashMap::new())),
            workspace_resolver: self.workspace_resolver.clone(),
            workspace_override: Arc::new(AsyncMutex::new(HashMap::new())),
            bot_configs: Arc::new(bot_configs),
        });
        let store: Arc<dyn ChannelStore> = Arc::new(AmuxdChannelStore {
            client: self.backend.clone(),
        });

        let mgr = ChannelManager::new(
            cfg,
            acp_handle,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
        );
        match mgr.start_enabled().await {
            Ok(()) => info!("channel manager: start_enabled() completed"),
            Err(e) => warn!("channel manager: start_enabled() failed: {e:?}"),
        }
        Some(mgr)
    }

    /// Construct the channel manager from `[channels.*]` entries in
    /// `daemon.toml` and call `start_enabled()` so every gateway whose
    /// section has `enabled = true` boots alongside the daemon. Best-effort:
    /// missing team_id (daemon not yet onboarded) or per-channel start
    /// failures are logged but do NOT abort daemon startup.
    pub(crate) async fn start_channels(&mut self) {
        let cfg = self.config.clone();
        self.channel_mgr = self.build_and_start_channel_manager(cfg).await;
    }

    /// Re-read `daemon.toml` from disk, tear down the running channel
    /// manager (if any), and bring up a fresh one. Used by the
    /// `channel-reload` control command. Failures are logged but never
    /// crash the daemon — partial reloads (e.g. config parsed but one
    /// channel fails to start) are acceptable.
    pub(crate) async fn reload_channels(&mut self) {
        let fresh_cfg = match DaemonConfig::load(&self.config_path) {
            Ok(c) => c,
            Err(e) => {
                error!("channel-reload: failed to read config: {e:?}");
                return;
            }
        };

        if let Some(mgr) = self.channel_mgr.take() {
            info!("channel-reload: shutting down current channel manager");
            mgr.shutdown().await;
        }

        // Update the in-memory copy so subsequent paths that read
        // `self.config` see the new values.
        self.config = fresh_cfg.clone();
        self.channel_mgr = self.build_and_start_channel_manager(fresh_cfg).await;
        info!("channel-reload: ok");
    }

    /// Build the JSON response payload for the `channel-status` sock command.
    /// Walks the six known channel platforms and reports each one's
    /// `enabled` (from `daemon.toml`) and `connected` (running gateway slot
    /// is `Some(_)`). `last_error` is always `None` for now — richer per-
    /// channel error tracking is intentionally out of scope here.
    pub(crate) async fn channel_status_payload(&self) -> String {
        #[derive(serde::Serialize)]
        struct ChannelStatus {
            platform: &'static str,
            enabled: bool,
            connected: bool,
            last_error: Option<String>,
        }

        let cfg = &self.config.channels;
        let enabled_flag = |platform: &str| -> bool {
            match platform {
                "discord" => cfg.discord.as_ref().map(|c| c.enabled).unwrap_or(false),
                "wecom" => cfg.wecom.as_ref().map(|c| c.enabled).unwrap_or(false),
                "feishu" => cfg.feishu.as_ref().map(|c| c.enabled).unwrap_or(false),
                "kook" => cfg.kook.as_ref().map(|c| c.enabled).unwrap_or(false),
                "wechat" => cfg.wechat.as_ref().map(|c| c.enabled).unwrap_or(false),
                "email" => cfg.email.as_ref().map(|c| c.enabled).unwrap_or(false),
                _ => false,
            }
        };

        let connected: Vec<(&'static str, bool, Option<String>)> = match self.channel_mgr.as_ref() {
            Some(mgr) => mgr.status_snapshot().await,
            None => vec![
                ("discord", false, None),
                ("wecom", false, None),
                ("feishu", false, None),
                ("kook", false, None),
                ("wechat", false, None),
                ("email", false, None),
            ],
        };

        let statuses: Vec<ChannelStatus> = connected
            .into_iter()
            .map(|(platform, connected, last_error)| ChannelStatus {
                platform,
                enabled: enabled_flag(platform),
                connected,
                last_error,
            })
            .collect();

        serde_json::to_string(&statuses).unwrap_or_else(|_| "[]".to_string())
    }

    /// Build the JSON response payload for the `wecom-bots-status` sock command:
    /// `[{botId, connected, error}, ...]`, one entry per resolved WeCom bot.
    /// Mirrors `channel_status_payload`'s shape; returns `[]` when no channel
    /// manager is running.
    pub(crate) async fn wecom_bots_status_payload(&self) -> String {
        let rows = match self.channel_mgr.as_ref() {
            Some(mgr) => mgr.wecom_bots_status().await,
            None => vec![],
        };
        let json: Vec<serde_json::Value> = rows
            .into_iter()
            .map(|(bot_id, connected, error)| {
                serde_json::json!({ "botId": bot_id, "connected": connected, "error": error })
            })
            .collect();
        serde_json::to_string(&json).unwrap_or_else(|_| "[]".to_string())
    }

    /// Handle a `mcp-send` JSON envelope from the `amuxd mcp-server` bridge.
    /// Parses the binding URI (e.g. `wecom://{corp}/{agent}/{kind}/{id}`) to
    /// derive the default channel + target, applies any explicit overrides,
    /// then routes the send through `ChannelManager::dispatch_send`. Returns
    /// a JSON-friendly success/error value (the listener serializes it).
    pub(crate) async fn handle_mcp_send(
        &self,
        payload: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let binding = payload
            .get("binding")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("mcp-send: missing 'binding'"))?;
        let message = payload.get("message").and_then(|v| v.as_str());
        let file_path = payload.get("file_path").and_then(|v| v.as_str());
        let target_override = payload.get("target_override").and_then(|v| v.as_str());
        let channel_override = payload.get("channel_override").and_then(|v| v.as_str());

        if message.map(|s| s.is_empty()).unwrap_or(true) && file_path.is_none() {
            anyhow::bail!("mcp-send: at least one of 'message' or 'file_path' is required");
        }

        let (default_channel, default_target) = parse_binding_to_target(binding)?;
        let channel = channel_override.unwrap_or(default_channel);
        let target_owned: String;
        let target = match target_override {
            Some(t) => t,
            None => match default_target {
                Some(t) => {
                    target_owned = t;
                    target_owned.as_str()
                }
                None => anyhow::bail!(
                    "mcp-send: binding '{binding}' has no default target — pass an explicit 'target' override"
                ),
            },
        };

        let mgr = self
            .channel_mgr
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("channel manager not running"))?;
        mgr.dispatch_send(channel, target, message, file_path)
            .await?;

        Ok(serde_json::json!({
            "channel": channel,
            "target": target,
            "message_sent": message.map(|s| !s.is_empty()).unwrap_or(false),
            "file_sent": file_path.is_some(),
        }))
    }

    // `handle_prompt_await` (cron-style ACP turn) lives in `server/cron.rs`.

    /// Persist a new per-platform channel config (parsed from the second line
    /// of a `channel-save` sock message) into `daemon.toml`, update the
    /// in-memory `self.config`, and reload the channel manager so the change
    /// takes effect immediately. Errors are logged but never crash the daemon.
    pub(crate) async fn save_channel_config(&mut self, platform: &str, config_json: &str) {
        let parsed: Result<(), String> = (|| -> Result<(), String> {
            match platform {
                "discord" => {
                    let v: crate::config::DiscordChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse discord: {e}"))?;
                    self.config.channels.discord = Some(v);
                }
                "wecom" => {
                    let v: crate::config::WeComChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse wecom: {e}"))?;
                    self.config.channels.wecom = Some(v);
                }
                "feishu" => {
                    let v: crate::config::FeishuChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse feishu: {e}"))?;
                    self.config.channels.feishu = Some(v);
                }
                "kook" => {
                    let v: crate::config::KookChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse kook: {e}"))?;
                    self.config.channels.kook = Some(v);
                }
                "wechat" => {
                    let v: crate::config::WeChatChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse wechat: {e}"))?;
                    self.config.channels.wechat = Some(v);
                }
                "email" => {
                    let v: crate::config::EmailChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse email: {e}"))?;
                    self.config.channels.email = Some(v);
                }
                other => {
                    return Err(format!("unknown platform '{other}'"));
                }
            }
            Ok(())
        })();

        if let Err(e) = parsed {
            error!("channel-save: {e}");
            return;
        }

        if let Err(e) = self.config.save(&self.config_path) {
            error!("channel-save: failed to persist daemon.toml: {e:?}");
            return;
        }

        info!("channel-save: persisted {platform}, reloading channel manager");
        self.reload_channels().await;
    }

    /// Tear down any running channels. Idempotent — safe to call when
    /// `channel_mgr` is `None`.
    pub(crate) async fn shutdown_channels(&mut self) {
        if let Some(mgr) = self.channel_mgr.take() {
            info!("shutting down channels...");
            mgr.shutdown().await;
        }
    }
}
