//! `AcpHandle` impl: bridges `teamclaw_gateway` channels to amuxd's
//! in-process `RuntimeManager` so a chat message arriving over Discord /
//! WeCom / Feishu / etc. drives an ACP turn without going through the
//! deprecated opencode HTTP server.
//!
//! ## Logical vs real ACP session ids
//!
//! Channels persist the SQL-minted `acp_session_id` (random hex from
//! `ensure_gateway_session`) on the `sessions` row and then pass it to
//! `send_prompt`. That string is a *logical* id — it was never registered
//! with amuxd's `RuntimeManager`, which only knows real ACP UUIDs returned
//! by `session/new`.
//!
//! To bridge the two, this handle keeps an in-memory `logical_to_acp` map.
//! On `send_prompt`, if the logical id has no entry, we lazy-spawn a fresh
//! agent via `create_gateway_session` and remember the mapping. On amuxd
//! restart the map is empty, so the first prompt for each persisted session
//! re-spawns; old conversation history stays in the cloud backend regardless.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use teamclaw_gateway::{AcpAvailableCommand, AgentInfo, AcpError, AcpHandle, AcpTurnOutcome, AmuxSessionId, ModelInfo, WorkspaceInfo};

use crate::backend::Backend;
use crate::proto::amux;
use crate::runtime::RuntimeManager;

/// Cached per-session state that lets `send_prompt` decide whether the
/// incoming prompt is the FIRST one for a freshly-spawned runtime (and
/// therefore should be prefixed with the one-shot system note about the
/// `send` MCP tool). Once `was_primed` flips true we never prepend the
/// preamble again for that logical session — even across restarts the
/// `logical_to_acp` map is in-memory only, so the next spawn re-issues
/// the preamble naturally.
#[derive(Clone)]
pub struct ResolvedSession {
    real_acp_sid: String,
    binding: String,
    was_primed: bool,
}

/// Per-bot runtime defaults, keyed by WeCom `bot_id`. Populated once when
/// the handle is built from `daemon.toml`; immutable for the handle's
/// lifetime (a `channel-reload` rebuilds the whole handle).
#[derive(Clone, Default)]
pub struct BotRuntimeConfig {
    /// Already-resolved local workspace directory (workspace_id -> path).
    pub workspace_dir: Option<String>,
    pub agent_type: Option<amux::AgentType>,
    pub system_prompt: Option<String>,
}

pub struct AmuxdAcpHandle {
    pub manager: Arc<Mutex<RuntimeManager>>,
    /// Logical (SQL-minted) acp_session_id → resolved runtime metadata.
    /// Created on first `send_prompt` after a daemon start; in-memory only.
    pub logical_to_acp: Arc<Mutex<HashMap<String, ResolvedSession>>>,
    /// Team id used when lazy-spawning a runtime on first `send_prompt`.
    /// Set by the F4 wiring layer when the handle is constructed.
    pub team_id: String,
    /// Per-session model override: logical_session_id → (provider, model).
    /// Set by `set_model`; consulted at lazy-spawn time so the spawned
    /// runtime starts on the user-chosen model. In-memory only — cleared
    /// across daemon restarts (same caveat as `logical_to_acp`).
    pub model_override: Arc<Mutex<HashMap<String, (String, String)>>>,
    /// Backend client used to look up `sessions.binding` from the
    /// SQL-minted `acp_session_id` when lazy-spawning a runtime. The
    /// binding is required to write the per-session MCP config file
    /// that mounts the `send` tool.
    pub backend: Arc<dyn Backend>,
    /// The daemon agent's own `default_agent_type`, resolved once when the
    /// channel manager is built (`GET /v1/runtime/agent-defaults`). Gateway
    /// runtimes spawn on this backend type instead of the daemon-wide default.
    /// `None` → fall back to the daemon default agent type.
    pub default_agent_type: Option<amux::AgentType>,
    /// Local filesystem path of the daemon agent's `default_workspace_id`,
    /// resolved via the `WorkspaceResolver` cache (backed by the cloud
    /// `amux.workspaces` table). Used as the gateway runtime's working
    /// directory instead of a throwaway `/tmp` scratch dir. `None` → fall
    /// back to a scratch dir (the workspace is unset or unresolvable).
    pub default_workspace_dir: Option<String>,
    /// Per-session agent type override: logical_session_id → AgentType.
    /// Set by `set_agent`; consulted at lazy-spawn time. In-memory only.
    pub agent_type_override: Arc<Mutex<HashMap<String, amux::AgentType>>>,
    /// Resolves a cloud workspace_id → local path (`amux.workspaces` is the
    /// sole source of truth). Used by `workspace_dir_for_id` for per-session
    /// spawn-target resolution.
    pub workspace_resolver: Arc<crate::config::WorkspaceResolver>,
    /// Per-session workspace override: logical_session_id → workspace_id.
    /// In-memory only — cleared across daemon restarts.
    pub workspace_override: Arc<Mutex<HashMap<String, String>>>,
    /// Per-bot (WeCom) runtime config keyed by bot_id. Immutable after
    /// construction; consulted in `resolve_or_spawn` and `send_prompt`.
    pub bot_configs: Arc<HashMap<String, BotRuntimeConfig>>,
}

/// Returned by `resolve_or_spawn`. `spawned` is true iff this call was
/// the one that lazy-spawned the runtime — used by `send_prompt` to
/// decide whether to prepend the system preamble.
struct ResolveOutcome {
    real_acp_sid: String,
    binding: String,
    spawned: bool,
}

impl AmuxdAcpHandle {
    /// Resolve the workspace dir + agent type for a spawn, applying priority
    /// **per-session override > per-bot config > daemon global default**.
    /// `workspace_override` stores a workspace_id, resolved to a path here;
    /// `bot_configs` already store a resolved path.
    async fn resolve_spawn_target(
        &self,
        session: &str,
        binding: &str,
    ) -> (Option<String>, Option<amux::AgentType>) {
        let bot = bot_id_from_binding(binding)
            .and_then(|b| self.bot_configs.get(b))
            .cloned()
            .unwrap_or_default();

        let agent_type = {
            let ov = self.agent_type_override.lock().await;
            ov.get(session).copied()
        }
        .or(bot.agent_type)
        .or(self.default_agent_type);

        let session_ws_id = {
            let ov = self.workspace_override.lock().await;
            ov.get(session).cloned()
        };
        let session_ws_dir = match session_ws_id {
            Some(wid) => self.workspace_dir_for_id(&wid).await,
            None => None,
        };

        let workspace_dir = session_ws_dir
            .or(bot.workspace_dir.clone())
            .or(self.default_workspace_dir.clone());

        (workspace_dir, agent_type)
    }

    /// Resolve a workspace_id to its local path via the `WorkspaceResolver`
    /// cache (`amux.workspaces` is the sole source of truth). `None` if the
    /// id is unknown, has no path, or the backend lookup fails.
    async fn workspace_dir_for_id(&self, workspace_id: &str) -> Option<String> {
        self.workspace_resolver
            .resolve(workspace_id)
            .await
            .ok()
            .map(|w| w.path)
    }

    /// Resolve the caller-supplied `session` (a logical id persisted on the
    /// `sessions` row) to a real ACP UUID, spawning a runtime on first use.
    /// On a fresh spawn, the matching `sessions.binding` is looked up from
    /// the backend so it can be baked into the per-session MCP config.
    async fn resolve_or_spawn(&self, session: &AmuxSessionId) -> Result<ResolveOutcome, AcpError> {
        {
            let map = self.logical_to_acp.lock().await;
            if let Some(existing) = map.get(session) {
                return Ok(ResolveOutcome {
                    real_acp_sid: existing.real_acp_sid.clone(),
                    binding: existing.binding.clone(),
                    spawned: false,
                });
            }
        }

        // Recover the remote session UUID + binding URI for this logical
        // session. The UUID is needed so the spawned runtime can carry it
        // on its handle, which is what daemon::server::target_sessions falls
        // back to when routing agent envelopes (otherwise gateway-spawned
        // runtimes — which never get written into the local SessionStore —
        // appear bound-less and their envelopes get dropped). The binding
        // feeds the per-session MCP config so `send` defaults to the
        // originating chat. A missing row is non-fatal; we still spawn so
        // basic prompt/reply works.
        let (remote_session_id, binding) = match self
            .backend
            .get_gateway_session_by_acp_id(session)
            .await
            .map_err(|e| AcpError::Create(format!("session lookup: {e}")))?
        {
            Some((id, bind)) => (Some(id), bind.unwrap_or_default()),
            None => (None, String::new()),
        };

        // Consult per-session override so the spawn picks up the desired
        // model. Stored as (provider, model); both fields are forwarded to
        // `create_gateway_session_with_model`, which calls `resolve_initial_model`
        // to build the correct ACP model id per backend:
        //   - ClaudeCode: maps short names (sonnet→claude-sonnet-4-6), drops provider
        //   - OpenCode/Codex: rejoins as "provider/model" (required by ACP)
        let model_arg: Option<(String, String)> = {
            let overrides = self.model_override.lock().await;
            overrides.get(session).cloned()
        };
        let (workspace_dir, agent_type) =
            self.resolve_spawn_target(session, &binding).await;
        let real = {
            let mut mgr = self.manager.lock().await;
            mgr.create_gateway_session_with_model(
                &self.team_id,
                session,
                &binding,
                "Gateway session",
                model_arg,
                remote_session_id.as_deref(),
                workspace_dir.as_deref(),
                agent_type,
            )
            .await
            .map_err(|e| AcpError::Create(e.to_string()))?
        };

        // Durable persona for ClaudeCode: write CLAUDE.local.md into the
        // bot's workspace. Non-fatal; the preamble already delivered it.
        if matches!(agent_type, Some(amux::AgentType::ClaudeCode) | None) {
            if let (Some(ws), Some(bot_id)) =
                (workspace_dir.as_deref(), bot_id_from_binding(&binding))
            {
                if let Some(prompt) = self
                    .bot_configs
                    .get(bot_id)
                    .and_then(|c| c.system_prompt.as_deref())
                {
                    if let Err(e) = super::bot_prompt_file::write_bot_instruction_file(
                        std::path::Path::new(ws),
                        prompt,
                    ) {
                        tracing::warn!(bot_id, error = %e, "write CLAUDE.local.md failed");
                    }
                }
            }
        }

        // Insert under a write lock; if a concurrent spawn raced ahead we
        // keep the existing entry so `was_primed` reflects whichever call
        // actually delivered the preamble first.
        let mut map = self.logical_to_acp.lock().await;
        let entry = map
            .entry(session.to_string())
            .or_insert_with(|| ResolvedSession {
                real_acp_sid: real.clone(),
                binding: binding.clone(),
                was_primed: false,
            });
        let outcome = ResolveOutcome {
            real_acp_sid: entry.real_acp_sid.clone(),
            binding: entry.binding.clone(),
            spawned: true,
        };
        Ok(outcome)
    }

    /// Mark a logical session as having received its priming system
    /// preamble so subsequent `send_prompt` calls don't repeat it.
    async fn mark_primed(&self, session: &str) {
        let mut map = self.logical_to_acp.lock().await;
        if let Some(entry) = map.get_mut(session) {
            entry.was_primed = true;
        }
    }

    /// Returns true if the logical session has already received its
    /// priming preamble. Lock is held briefly — callers that want a
    /// consistent decision should pair this with `mark_primed`.
    async fn already_primed(&self, session: &str) -> bool {
        let map = self.logical_to_acp.lock().await;
        map.get(session).map(|e| e.was_primed).unwrap_or(false)
    }
}

/// Extract the channel scheme from a binding URI (`wecom://…` →
/// `wecom`). Used in the priming preamble so the agent knows which
/// gateway it's talking through. Falls back to `gateway` when the URI
/// doesn't parse cleanly.
fn channel_name_from_binding(binding: &str) -> &str {
    if binding.is_empty() {
        return "gateway";
    }
    match binding.split_once("://") {
        Some((scheme, _)) if !scheme.is_empty() => scheme,
        _ => "gateway",
    }
}

/// Extract the WeCom bot id from a `wecom://<bot_id>/...` binding so the
/// handle can pick the per-bot runtime config. Returns None for non-wecom
/// or malformed bindings (callers fall back to the global default).
pub fn bot_id_from_binding(binding: &str) -> Option<&str> {
    let rest = binding.strip_prefix("wecom://")?;
    rest.split('/').next().filter(|s| !s.is_empty())
}

/// Build the first-turn prompt for a freshly-spawned gateway session: the
/// per-bot persona (if any), then the standard send-tool note, then the
/// user's message. Subsequent turns use `[sender] text` only.
pub fn build_first_turn_prompt(
    channel: &str,
    bot_system_prompt: Option<&str>,
    sender_display: &str,
    text: &str,
) -> String {
    let persona = match bot_system_prompt {
        Some(p) if !p.trim().is_empty() => format!("[SYSTEM] {p}\n\n"),
        _ => String::new(),
    };
    format!(
        "{persona}[SYSTEM] You are connected to a {channel} chat via amuxd. To send a follow-up \
message or upload a file back to this chat without waiting for the user to ask, call the `send` \
MCP tool (server name `amuxd-send`). `target` and `channel` default to the current session's \
bound chat, so a simple `send(message=\"…\")` or `send(file_path=\"/tmp/report.pdf\")` is enough.\n\n\
[{sender_display}] {text}"
    )
}

#[async_trait]
impl AcpHandle for AmuxdAcpHandle {
    async fn create_session(
        &self,
        _team_id: &str,
        binding: &str,
        _title: &str,
    ) -> Result<AmuxSessionId, AcpError> {
        // Channels never call this in the gateway-port architecture — the
        // SQL store mints the logical acp_session_id via
        // `ensure_gateway_session`. We keep a consistent implementation in
        // case future callers use it: hand back the binding as the logical
        // id; `send_prompt` will lazy-spawn on first use.
        Ok(binding.to_string())
    }

    async fn send_prompt(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
    ) -> Result<AcpTurnOutcome, AcpError> {
        let outcome = self.resolve_or_spawn(session).await?;

        // First prompt after a fresh spawn gets a one-shot system preamble
        // explaining the `send` MCP tool and its defaults. `resolve_or_spawn`
        // tells us whether this call did the spawning, but a concurrent
        // caller may have already primed the session — `already_primed`
        // settles the race so we never double-prime.
        let needs_preamble = outcome.spawned && !self.already_primed(session).await;
        let prompt = if needs_preamble {
            let channel = channel_name_from_binding(&outcome.binding);
            let bot_prompt = bot_id_from_binding(&outcome.binding)
                .and_then(|b| self.bot_configs.get(b))
                .and_then(|c| c.system_prompt.as_deref());
            build_first_turn_prompt(channel, bot_prompt, sender_display, text)
        } else {
            format!("[{sender_display}] {text}")
        };

        if needs_preamble {
            self.mark_primed(session).await;
        }

        // Per-session concurrency model:
        //
        //   1. Grab the per-agent `turn_lock` Arc under a brief manager
        //      lock and immediately release the manager mutex.
        //   2. Acquire `turn_lock` — serialises only *this* agent's turns.
        //      Different agents have different locks, so two concurrent
        //      wecom sessions never block each other here.
        //   3. Re-acquire the manager mutex *briefly* to send the prompt
        //      and check the agent's `event_rx` out of the handle. With
        //      `turn_lock` held the checkout cannot race.
        //   4. Drive the aggregator off the local `event_rx.recv().await`
        //      *without* holding the manager mutex. Re-lock only for the
        //      sub-millisecond `aggregator.ingest(&event)` call after each
        //      event. While we're waiting on the model, the manager mutex
        //      stays free so other sessions can poll events / spawn / etc.
        //   5. Always check the receiver back in (success or error) before
        //      dropping the turn_lock guard so `poll_events` resumes
        //      draining the next round.

        let turn_lock = {
            let mgr = self.manager.lock().await;
            let agent_id = mgr
                .agent_id_by_acp_session(&outcome.real_acp_sid)
                .ok_or_else(|| {
                    AcpError::Send(format!(
                        "no agent for acp_session_id {}",
                        outcome.real_acp_sid
                    ))
                })?;
            let handle = mgr.get_handle(&agent_id).ok_or_else(|| {
                AcpError::Send(format!("agent {agent_id} disappeared before turn"))
            })?;
            handle.turn_lock.clone()
        };
        let _turn_guard = turn_lock.lock().await;

        let (agent_id, mut event_rx) = {
            let mut mgr = self.manager.lock().await;
            let (turn, _again) = mgr
                .checkout_turn_for_acp(&outcome.real_acp_sid)
                .map_err(|e| AcpError::Send(e.to_string()))?;
            mgr.send_prompt_raw(&turn.agent_id, &prompt, vec![])
                .await
                .map_err(|e| AcpError::Send(e.to_string()))?;
            (turn.agent_id, turn.event_rx)
        };

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5 * 60);
        let result: Result<String, AcpError> = loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break Err(AcpError::Timeout);
            }
            let next = tokio::time::timeout(remaining, event_rx.recv()).await;
            let event = match next {
                Ok(Some(ev)) => ev,
                Ok(None) => {
                    break Err(AcpError::Send(
                        "ACP event channel closed before reply".into(),
                    ))
                }
                Err(_) => break Err(AcpError::Timeout),
            };
            if let Some(crate::proto::amux::acp_event::Event::Error(err)) = &event.event.event {
                let details = if err.details.is_empty() {
                    err.message.clone()
                } else {
                    err.details.clone()
                };
                break Err(AcpError::Send(format!("ACP turn failed: {details}")));
            }
            let emitted = {
                let mut mgr = self.manager.lock().await;
                mgr.aggregator_mut(&agent_id)
                    .map(|agg| agg.ingest(&event.event))
                    .unwrap_or_default()
            };
            let mut reply: Option<String> = None;
            for m in emitted {
                if matches!(m.kind, crate::proto::teamclaw::MessageKind::AgentReply) {
                    reply = Some(m.content);
                    break;
                }
            }
            if let Some(text) = reply {
                break Ok(text);
            }
        };

        {
            let mut mgr = self.manager.lock().await;
            mgr.checkin_turn(crate::runtime::CheckedOutTurn { agent_id, event_rx });
        }

        let reply_text = result?;
        Ok(AcpTurnOutcome {
            reply_text,
            completed: true,
        })
    }

    async fn inject_context(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
    ) -> Result<(), AcpError> {
        let outcome = self.resolve_or_spawn(session).await?;
        let mut mgr = self.manager.lock().await;
        mgr.inject_context(&outcome.real_acp_sid, sender_display, text)
            .await
            .map_err(|e| AcpError::Send(e.to_string()))
    }

    async fn cancel(&self, session: &AmuxSessionId) -> Result<(), AcpError> {
        let map = self.logical_to_acp.lock().await;
        let real = match map.get(session) {
            Some(s) => s.real_acp_sid.clone(),
            None => return Ok(()), // never spawned, nothing to cancel
        };
        drop(map);
        let mut mgr = self.manager.lock().await;
        mgr.cancel_by_acp_session(&real)
            .await
            .map_err(|e| AcpError::Send(format!("cancel failed: {e}")))
    }

    async fn reset_session(&self, session: &AmuxSessionId) -> Result<(), AcpError> {
        // Cancel + drop from map. Next send_prompt re-spawns under the
        // same logical id with a fresh runtime — preserves the gateway-side
        // identity so persisted `sessions.binding` keeps working.
        let _ = self.cancel(session).await; // best-effort
        let mut map = self.logical_to_acp.lock().await;
        map.remove(session);
        Ok(())
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, AcpError> {
        // Hardcoded for the claude-code adapter in v1 of the gateway port.
        // Future work: read from daemon.toml once we have multi-binary
        // routing (codex-cli, etc.).
        Ok(vec![
            ModelInfo {
                provider: "anthropic".into(),
                model: "sonnet".into(),
                display_name: "Claude Sonnet (default, fast)".into(),
            },
            ModelInfo {
                provider: "anthropic".into(),
                model: "opus".into(),
                display_name: "Claude Opus (high-capability)".into(),
            },
            ModelInfo {
                provider: "anthropic".into(),
                model: "haiku".into(),
                display_name: "Claude Haiku (cheapest)".into(),
            },
        ])
    }

    async fn set_model(
        &self,
        session: &AmuxSessionId,
        provider: &str,
        model: &str,
    ) -> Result<(), AcpError> {
        // Validate against list_models so /model only accepts known names.
        let valid = self.list_models().await?;
        if !valid
            .iter()
            .any(|m| m.provider == provider && m.model == model)
        {
            return Err(AcpError::Send(format!(
                "unknown model {provider}/{model}; use list_models to enumerate"
            )));
        }

        // Store override before tearing down the runtime so the lazy-spawn
        // that follows on the next prompt picks up the new model.
        {
            let mut overrides = self.model_override.lock().await;
            overrides.insert(
                session.to_string(),
                (provider.to_string(), model.to_string()),
            );
        }

        // Cancel current runtime + drop logical→acp mapping so the next
        // send_prompt lazy-spawns under the new model. Conversation context
        // is lost — same semantics as v1 /model.
        let _ = self.cancel(session).await;
        let mut map = self.logical_to_acp.lock().await;
        map.remove(session);

        Ok(())
    }

    async fn available_commands(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<AcpAvailableCommand>, AcpError> {
        // ── 1. Agent-reported commands (only if session is already spawned) ────
        // Built-ins (step 2) and workspace skills (step 3) are always returned
        // regardless of whether a runtime has been spawned for this session.
        let mut result: Vec<AcpAvailableCommand> = {
            let map = self.logical_to_acp.lock().await;
            let real = map.get(session).map(|s| s.real_acp_sid.clone());
            drop(map);
            if let Some(real) = real {
                let mgr = self.manager.lock().await;
                if let Some(agent_id) = mgr.agent_id_by_acp_session(&real) {
                    mgr.get_available_commands(&agent_id)
                        .into_iter()
                        .map(|c| AcpAvailableCommand {
                            name: c.name,
                            description: c.description,
                            input_hint: if c.input_hint.is_empty() { None } else { Some(c.input_hint) },
                        })
                        .collect()
                } else {
                    vec![]
                }
            } else {
                vec![]
            }
        };

        // Resolve agent type: per-session override → default → ClaudeCode fallback.
        let agent_type = {
            let overrides = self.agent_type_override.lock().await;
            overrides.get(session.as_str()).copied().or(self.default_agent_type)
        };

        // ── 2. Agent built-in commands (ClaudeCode doesn't report via AcpAvailableCommands) ──
        let known = match agent_type {
            Some(t) if t == amux::AgentType::ClaudeCode => &[
                ("compact", "Compact the conversation history", ""),
                ("cost", "Show token cost for this session", ""),
            ][..],
            _ => &[][..],
        };
        for (name, description, hint) in known {
            if !result.iter().any(|c| c.name == *name) {
                result.push(AcpAvailableCommand {
                    name: name.to_string(),
                    description: description.to_string(),
                    input_hint: if hint.is_empty() { None } else { Some(hint.to_string()) },
                });
            }
        }

        Ok(result)
    }

    async fn list_skills(
        &self,
        _session: &AmuxSessionId,
    ) -> Result<Vec<(String, String)>, AcpError> {
        use crate::config::scan_roles_skills_state;
        let Some(ws_dir) = &self.default_workspace_dir else {
            return Ok(vec![]);
        };
        let state = scan_roles_skills_state(std::path::Path::new(ws_dir))
            .map_err(|e| AcpError::Internal(format!("skill scan: {e}")))?;
        let mut skills: Vec<(String, String)> = state
            .skills
            .into_iter()
            .map(|s| {
                let name = s
                    .invocation_name
                    .unwrap_or_else(|| s.filename.trim_end_matches(".md").to_string());
                (name, s.description)
            })
            .collect();
        skills.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(skills)
    }

    async fn send_slash_command(
        &self,
        session: &AmuxSessionId,
        name: &str,
        input: Option<&str>,
    ) -> Result<AcpTurnOutcome, AcpError> {
        let text = match input {
            Some(inp) if !inp.is_empty() => format!("/{name} {inp}"),
            _ => format!("/{name}"),
        };
        self.send_prompt(session, "user", &text).await
    }

    async fn list_sessions(
        &self,
        active_session: &AmuxSessionId,
    ) -> Result<Vec<(AmuxSessionId, bool)>, AcpError> {
        let map = self.logical_to_acp.lock().await;
        Ok(map.keys().map(|k| (k.clone(), k == active_session)).collect())
    }

    async fn list_agents(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<AgentInfo>, AcpError> {
        let current = {
            let overrides = self.agent_type_override.lock().await;
            overrides
                .get(session.as_str())
                .copied()
                .or(self.default_agent_type)
                .unwrap_or(amux::AgentType::ClaudeCode)
        };
        Ok(vec![
            AgentInfo { agent_type: "claude-code".to_string(), is_current: current == amux::AgentType::ClaudeCode },
            AgentInfo { agent_type: "opencode".to_string(), is_current: current == amux::AgentType::Opencode },
            AgentInfo { agent_type: "codex".to_string(), is_current: current == amux::AgentType::Codex },
        ])
    }

    async fn set_agent(
        &self,
        session: &AmuxSessionId,
        agent_type: &str,
    ) -> Result<(), AcpError> {
        let t = match agent_type {
            "claude-code" => amux::AgentType::ClaudeCode,
            "opencode" => amux::AgentType::Opencode,
            "codex" => amux::AgentType::Codex,
            other => return Err(AcpError::NotFound(format!(
                "unknown agent type '{other}'; valid: claude-code, opencode, codex"
            ))),
        };
        {
            let mut overrides = self.agent_type_override.lock().await;
            overrides.insert(session.to_string(), t);
        }
        // Acquire the map, extract + remove the entry atomically, then cancel
        // via the manager. This prevents a concurrent send_prompt from
        // re-inserting between the cancel and remove (TOCTOU).
        let real_sid = {
            let mut map = self.logical_to_acp.lock().await;
            let sid = map.get(session).map(|s| s.real_acp_sid.clone());
            map.remove(session);
            sid
        };
        if let Some(real) = real_sid {
            let mut mgr = self.manager.lock().await;
            let _ = mgr.cancel_by_acp_session(&real).await;
        }
        Ok(())
    }

    /// Enumerates workspaces from the cloud `amux.workspaces` table
    /// (`Backend::get_workspaces_by_team`), filtered down to rows that
    /// resolve to a linkable, on-disk path on *this* machine — the cloud
    /// list spans every device on the team, so most rows will not resolve
    /// locally. `amux.workspaces` is the sole source of truth; there is no
    /// more local `WorkspaceStore`/`workspaces.toml` to enumerate.
    async fn list_workspaces(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<WorkspaceInfo>, AcpError> {
        let rows = self
            .backend
            .get_workspaces_by_team(&self.team_id)
            .await
            .map_err(|e| AcpError::Internal(format!("get_workspaces_by_team: {e}")))?;
        let current_id = {
            let overrides = self.workspace_override.lock().await;
            overrides.get(session.as_str()).cloned()
        };
        let current_id = match current_id {
            Some(id) => Some(id),
            None => self
                .backend
                .get_agent_defaults(self.backend.actor_id())
                .await
                .ok()
                .and_then(|d| d.default_workspace_id),
        };
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let path = row.path.as_deref()?.trim();
                if path.is_empty() || !crate::config::workspace_path::is_linkable_workspace_path(path) {
                    return None;
                }
                if !std::path::Path::new(path).is_dir() {
                    return None;
                }
                let display_name = std::path::Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.to_string());
                Some(WorkspaceInfo {
                    workspace_id: row.id.clone(),
                    display_name,
                    is_current: current_id.as_deref() == Some(row.id.as_str()),
                })
            })
            .collect())
    }

    async fn set_workspace(
        &self,
        session: &AmuxSessionId,
        workspace_id: &str,
    ) -> Result<(), AcpError> {
        let rows = self
            .backend
            .get_workspaces_by_team(&self.team_id)
            .await
            .map_err(|e| AcpError::Internal(format!("get_workspaces_by_team: {e}")))?;
        if !rows.iter().any(|w| w.id == workspace_id) {
            return Err(AcpError::NotFound(format!(
                "workspace '{workspace_id}' not found"
            )));
        }
        {
            let mut overrides = self.workspace_override.lock().await;
            overrides.insert(session.to_string(), workspace_id.to_string());
        }
        // Atomically remove entry then cancel to avoid TOCTOU race.
        let real_sid = {
            let mut map = self.logical_to_acp.lock().await;
            let sid = map.get(session).map(|s| s.real_acp_sid.clone());
            map.remove(session);
            sid
        };
        if let Some(real) = real_sid {
            let mut mgr = self.manager.lock().await;
            let _ = mgr.cancel_by_acp_session(&real).await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::mock::MockBackend;
    use crate::runtime::RuntimeManager;

    fn make_handle() -> AmuxdAcpHandle {
        make_handle_with_backend(Arc::new(MockBackend::default()))
    }

    /// Like `make_handle`, but wires the given backend Arc into BOTH
    /// `handle.backend` and `handle.workspace_resolver` so a test can seed
    /// `amux.workspaces` rows (via `backend.state().workspaces_by_id`) and
    /// have `resolve_spawn_target` -> `workspace_dir_for_id` -> the resolver
    /// actually see them, rather than a disconnected default backend.
    fn make_handle_with_backend(backend: Arc<MockBackend>) -> AmuxdAcpHandle {
        AmuxdAcpHandle {
            manager: Arc::new(Mutex::new(RuntimeManager::new(
                RuntimeManager::default_launch_configs(),
                None,
            ))),
            logical_to_acp: Arc::new(Mutex::new(HashMap::new())),
            team_id: "team-test".to_string(),
            model_override: Arc::new(Mutex::new(HashMap::new())),
            backend: backend.clone(),
            default_agent_type: None,
            default_workspace_dir: None,
            agent_type_override: Arc::new(Mutex::new(HashMap::new())),
            workspace_resolver: Arc::new(crate::config::WorkspaceResolver::new(backend)),
            workspace_override: Arc::new(Mutex::new(HashMap::new())),
            bot_configs: Arc::new(HashMap::new()),
        }
    }

    #[test]
    fn bot_id_parsed_from_wecom_binding() {
        assert_eq!(bot_id_from_binding("wecom://botX/botX/single/u1"), Some("botX"));
        assert_eq!(bot_id_from_binding("wecom://botY/botY/group/c9"), Some("botY"));
        assert_eq!(bot_id_from_binding("discord://g/c"), None);
        assert_eq!(bot_id_from_binding(""), None);
    }

    #[tokio::test]
    async fn resolution_priority_session_over_bot_over_global() {
        use amux::AgentType;
        let mut bots = HashMap::new();
        bots.insert(
            "botA".to_string(),
            BotRuntimeConfig {
                workspace_dir: Some("/ws/bot-a".into()),
                agent_type: Some(AgentType::Opencode),
                system_prompt: Some("A".into()),
            },
        );
        let mut handle = make_handle();
        handle.bot_configs = Arc::new(bots);
        handle.default_workspace_dir = Some("/ws/global".into());
        handle.default_agent_type = Some(AgentType::ClaudeCode);

        let (ws, at) = handle.resolve_spawn_target("sess-A", "wecom://botA/botA/single/u").await;
        assert_eq!(ws.as_deref(), Some("/ws/bot-a"));
        assert_eq!(at, Some(AgentType::Opencode));

        let (ws2, at2) = handle.resolve_spawn_target("sess-Z", "wecom://botZ/botZ/single/u").await;
        assert_eq!(ws2.as_deref(), Some("/ws/global"));
        assert_eq!(at2, Some(AgentType::ClaudeCode));

        handle.agent_type_override.lock().await.insert("sess-A".into(), AgentType::Codex);
        let (_ws3, at3) = handle.resolve_spawn_target("sess-A", "wecom://botA/botA/single/u").await;
        assert_eq!(at3, Some(AgentType::Codex));
    }

    /// Exercises the ASYNC workspace-resolution path end to end:
    /// `resolve_spawn_target` -> `workspace_dir_for_id` -> `WorkspaceResolver::resolve`
    /// -> `Backend::get_workspaces_by_ids`. Seeds a real workspace row in
    /// `MockBackend` (id -> path), wires that SAME backend Arc into the
    /// resolver via `make_handle_with_backend`, and asserts the
    /// session-level `workspace_override` (a workspace_id, not a raw path)
    /// resolves through to the seeded path — while a bot-level and a
    /// global-level workspace_dir (plain paths, no resolver involvement)
    /// remain configured but are correctly shadowed by the higher-priority
    /// session override, proving priority still holds through the resolver.
    #[tokio::test]
    async fn resolution_priority_session_override_resolves_via_workspace_resolver() {
        use crate::backend::WorkspaceRow;
        use amux::AgentType;

        let backend = Arc::new(MockBackend::default());
        let session_ws_id = "ws-session-1234";
        backend.state().workspaces_by_id.insert(
            session_ws_id.to_string(),
            WorkspaceRow {
                id: session_ws_id.to_string(),
                team_id: "team-test".to_string(),
                path: Some("/tmp/ws-session".to_string()),
            },
        );

        let mut handle = make_handle_with_backend(backend);

        // Bot-level and global-level defaults point at different, plain
        // (non-resolver) paths so we can prove they're shadowed.
        let mut bots = HashMap::new();
        bots.insert(
            "botA".to_string(),
            BotRuntimeConfig {
                workspace_dir: Some("/ws/bot-a".into()),
                agent_type: Some(AgentType::Opencode),
                system_prompt: None,
            },
        );
        handle.bot_configs = Arc::new(bots);
        handle.default_workspace_dir = Some("/ws/global".into());

        handle
            .workspace_override
            .lock()
            .await
            .insert("sess-resolved".to_string(), session_ws_id.to_string());

        let (ws, _at) = handle
            .resolve_spawn_target("sess-resolved", "wecom://botA/botA/single/u")
            .await;
        assert_eq!(
            ws.as_deref(),
            Some("/tmp/ws-session"),
            "session-level workspace_id override must resolve through WorkspaceResolver \
             and win over bot-level / global defaults"
        );

        // Sanity: pointing the override at an unseeded id must NOT trivially
        // pass through as a literal path — the resolver returns None on a
        // lookup miss, so priority falls back to the bot-level default.
        handle
            .workspace_override
            .lock()
            .await
            .insert("sess-unseeded".to_string(), "ws-does-not-exist".to_string());
        let (ws2, _at2) = handle
            .resolve_spawn_target("sess-unseeded", "wecom://botA/botA/single/u")
            .await;
        assert_eq!(
            ws2.as_deref(),
            Some("/ws/bot-a"),
            "unseeded workspace_id must fail to resolve and fall back to bot-level default"
        );
    }

    #[test]
    fn preamble_includes_bot_system_prompt() {
        let p = build_first_turn_prompt("wecom", Some("你是法务助手，只用中文回答。"), "Alice", "你好");
        assert!(p.contains("你是法务助手"));
        assert!(p.contains("[Alice] 你好"));
        assert!(p.contains("amuxd-send"), "keeps the send-tool note");
    }

    #[test]
    fn preamble_without_bot_prompt_matches_legacy() {
        let p = build_first_turn_prompt("wecom", None, "Bob", "hi");
        assert!(p.contains("amuxd-send"));
        assert!(p.contains("[Bob] hi"));
    }

    /// Verify `set_model` stores `(provider, model)` as a tuple so the
    /// lazy-spawn in `resolve_or_spawn` forwards BOTH to
    /// `create_gateway_session_with_model`.  The provider must be preserved
    /// because `resolve_initial_model` needs it to reconstruct the full ACP
    /// model id for OpenCode/Codex backends.
    #[tokio::test]
    async fn set_model_stores_provider_and_model_tuple() {
        let handle = make_handle();
        let session = AmuxSessionId::from("sess-1");

        // Simulate a user choosing an OpenCode provider/model.
        // set_model validates against list_models(), which for ClaudeCode
        // returns the three hardcoded models. Use one of those to avoid a
        // validation error; the important assertion is that the tuple is
        // stored intact.
        handle
            .set_model(&session, "anthropic", "sonnet")
            .await
            .unwrap();

        let overrides = handle.model_override.lock().await;
        let stored = overrides.get("sess-1").cloned().unwrap();
        assert_eq!(stored.0, "anthropic", "provider must be stored");
        assert_eq!(stored.1, "sonnet", "model must be stored");
    }

    #[tokio::test]
    async fn set_model_updates_existing_override() {
        let handle = make_handle();
        let session = AmuxSessionId::from("sess-2");

        handle
            .set_model(&session, "anthropic", "sonnet")
            .await
            .unwrap();
        handle
            .set_model(&session, "anthropic", "opus")
            .await
            .unwrap();

        let overrides = handle.model_override.lock().await;
        let stored = overrides.get("sess-2").cloned().unwrap();
        assert_eq!(stored.1, "opus", "second set_model must overwrite");
    }
}
