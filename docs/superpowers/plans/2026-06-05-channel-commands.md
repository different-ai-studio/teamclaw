# Channel Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a universal slash-command system to `teamclaw-gateway` so every channel gateway (WeChat Work, Discord, Feishu, etc.) can handle `/command` messages with two-layer dispatch: ACP agent commands take priority, gateway meta-commands are the fallback.

**Architecture:** A new `commands.rs` module in `teamclaw-gateway` exposes `parse_slash` + `dispatch`. `dispatch` first checks what commands the ACP agent has advertised; if the incoming command matches one of those it forwards via `send_slash_command`; otherwise it falls through to 8 built-in meta-commands (`/help`, `/model`, `/sessions`, `/agents`, `/workspaces`, `/clear`, `/stop`, `/ctx`). The `AcpHandle` trait gains 7 new methods; `AmuxdAcpHandle` in the daemon implements them by reading from `RuntimeManager`'s existing caches. The existing ad-hoc `dispatch_session_slash_cmd` in `wecom.rs` is replaced by the generic dispatcher.

**Tech Stack:** Rust, `async-trait`, `tokio`, `teamclaw-gateway` crate, `apps/daemon`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `crates/teamclaw-gateway/src/acp.rs` | Modify | Add `AcpAvailableCommand` struct + 7 new trait methods |
| `crates/teamclaw-gateway/src/commands.rs` | **Create** | `parse_slash`, `dispatch`, `MetaCommand` enum, unit tests |
| `crates/teamclaw-gateway/src/lib.rs` | Modify | Export `pub mod commands` |
| `apps/daemon/src/channels/acp_handle.rs` | Modify | Add 2 new fields; implement 7 new trait methods |
| `apps/daemon/src/runtime/manager.rs` | Modify | Add `get_available_commands` public getter |
| `apps/daemon/src/daemon/server.rs` | Modify | Pass `workspaces_path` when constructing `AmuxdAcpHandle` |
| `crates/teamclaw-gateway/src/wecom.rs` | Modify | Replace ad-hoc dispatch with `commands::parse_slash` + `commands::dispatch` |

---

## Task 1: Extend `AcpHandle` trait

**Files:**
- Modify: `crates/teamclaw-gateway/src/acp.rs`

- [ ] **Step 1: Add `AcpAvailableCommand` struct and 7 new trait methods**

Open `crates/teamclaw-gateway/src/acp.rs`. After the `ModelInfo` struct (line 8), add:

```rust
/// A slash command advertised by the ACP agent via `AcpAvailableCommands`.
#[derive(Debug, Clone)]
pub struct AcpAvailableCommand {
    pub name: String,
    pub description: String,
    /// Non-empty means the command accepts free-form text input.
    pub input_hint: String,
}
```

Then inside the `AcpHandle` trait (after `set_model`, before the closing `}`), add:

```rust
    /// Return the slash commands the running ACP agent has currently advertised.
    /// Returns an empty vec if the session hasn't spawned yet or the agent
    /// hasn't reported commands. Used by `commands::dispatch` for ACP-first priority.
    async fn available_commands(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<AcpAvailableCommand>, AcpError>;

    /// Forward a slash command to the ACP agent. Only call after confirming
    /// via `available_commands` that the agent knows this command.
    /// Behaves like `send_prompt` — returns the agent's reply text.
    async fn send_slash_command(
        &self,
        session: &AmuxSessionId,
        name: &str,
        input: Option<&str>,
    ) -> Result<AcpTurnOutcome, AcpError>;

    /// List all logical sessions this handle knows about (spawned since last
    /// daemon restart). Returns `(session_id, is_current)` pairs.
    async fn list_sessions(
        &self,
        current: &AmuxSessionId,
    ) -> Result<Vec<(AmuxSessionId, bool)>, AcpError>;

    /// List available agent types. Returns `(type_name, is_current)` pairs.
    async fn list_agents(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<(String, bool)>, AcpError>;

    /// Set agent type for this session. Resets the runtime — conversation
    /// context is lost (same semantics as `set_model`).
    async fn set_agent(
        &self,
        session: &AmuxSessionId,
        agent_type: &str,
    ) -> Result<(), AcpError>;

    /// List workspaces known to the daemon.
    /// Returns `(workspace_id, display_name, is_current)` triples.
    async fn list_workspaces(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<(String, String, bool)>, AcpError>;

    /// Set workspace for this session. Resets the runtime.
    async fn set_workspace(
        &self,
        session: &AmuxSessionId,
        workspace_id: &str,
    ) -> Result<(), AcpError>;
```

- [ ] **Step 2: Verify it compiles (trait only — no impl yet)**

```bash
CI=1 node scripts/rust-cli.js check 2>&1 | grep -E "^error" | head -20
```

Expected: errors about `AmuxdAcpHandle` not implementing the new methods — that's fine. Zero errors about `acp.rs` itself.

- [ ] **Step 3: Commit**

```bash
git add crates/teamclaw-gateway/src/acp.rs
git commit -m "feat(gateway): extend AcpHandle with slash-command + session/agent/workspace methods"
```

---

## Task 2: Add getter to `RuntimeManager`

**Files:**
- Modify: `apps/daemon/src/runtime/manager.rs`

- [ ] **Step 1: Add `get_available_commands` public getter**

In `apps/daemon/src/runtime/manager.rs`, after `set_available_commands` (around line 290), add:

```rust
    /// Return the slash commands last reported by `agent_id`, or an empty vec.
    pub fn get_available_commands(&self, agent_id: &str) -> Vec<amux::AcpAvailableCommand> {
        self.available_commands_per_agent
            .get(agent_id)
            .cloned()
            .unwrap_or_default()
    }
```

- [ ] **Step 2: Verify it compiles**

```bash
CI=1 node scripts/rust-cli.js check 2>&1 | grep "^error" | head -10
```

Expected: same trait-missing errors as before, no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/runtime/manager.rs
git commit -m "feat(daemon): add RuntimeManager::get_available_commands getter"
```

---

## Task 3: Implement new trait methods in `AmuxdAcpHandle`

**Files:**
- Modify: `apps/daemon/src/channels/acp_handle.rs`
- Modify: `apps/daemon/src/daemon/server.rs`

- [ ] **Step 1: Add new fields to `AmuxdAcpHandle`**

In `apps/daemon/src/channels/acp_handle.rs`, add two fields to the `AmuxdAcpHandle` struct (after `default_workspace_dir`):

```rust
    /// Per-session agent type override: logical_session_id → AgentType.
    /// Set by `set_agent`; consulted at lazy-spawn time. In-memory only.
    pub agent_type_override: Arc<Mutex<HashMap<String, amux::AgentType>>>,
    /// Path to workspaces.toml — read by `list_workspaces` on demand.
    pub workspaces_path: std::path::PathBuf,
```

- [ ] **Step 2: Wire new fields in `server.rs`**

In `apps/daemon/src/daemon/server.rs`, find the `AmuxdAcpHandle { … }` constructor block (line ~568) and add the two new fields:

```rust
        let acp_handle: Arc<dyn AcpHandle> = Arc::new(AmuxdAcpHandle {
            manager: self.agents.clone(),
            logical_to_acp: Arc::new(AsyncMutex::new(HashMap::new())),
            team_id: team_id.clone(),
            model_override: Arc::new(AsyncMutex::new(HashMap::new())),
            backend: self.backend.clone(),
            default_agent_type,
            default_workspace_dir,
            agent_type_override: Arc::new(AsyncMutex::new(HashMap::new())),
            workspaces_path: self.workspaces_path.clone(),
        });
```

- [ ] **Step 3: Wire new fields in the test helper `make_handle` in `acp_handle.rs`**

Find `fn make_handle()` (line ~452) and add the two new fields:

```rust
    fn make_handle() -> AmuxdAcpHandle {
        AmuxdAcpHandle {
            manager: Arc::new(Mutex::new(RuntimeManager::new(
                RuntimeManager::default_launch_configs(),
                None,
            ))),
            logical_to_acp: Arc::new(Mutex::new(HashMap::new())),
            team_id: "team-test".to_string(),
            model_override: Arc::new(Mutex::new(HashMap::new())),
            backend: Arc::new(MockBackend::default()),
            default_agent_type: None,
            default_workspace_dir: None,
            agent_type_override: Arc::new(Mutex::new(HashMap::new())),
            workspaces_path: std::path::PathBuf::from("/tmp/test-workspaces.toml"),
        }
    }
```

Also update the import at the top of `acp_handle.rs` to include `AmuxSessionId`:

```rust
use teamclaw_gateway::{AcpAvailableCommand, AcpError, AcpHandle, AcpTurnOutcome, AmuxSessionId, ModelInfo};
```

- [ ] **Step 4: Implement `available_commands`**

In the `impl AcpHandle for AmuxdAcpHandle` block, add after `set_model`:

```rust
    async fn available_commands(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<AcpAvailableCommand>, AcpError> {
        let map = self.logical_to_acp.lock().await;
        let real = match map.get(session) {
            Some(s) => s.real_acp_sid.clone(),
            None => return Ok(vec![]),
        };
        drop(map);
        let mgr = self.manager.lock().await;
        let agent_id = match mgr.agent_id_by_acp_session(&real) {
            Some(id) => id,
            None => return Ok(vec![]),
        };
        Ok(mgr
            .get_available_commands(&agent_id)
            .into_iter()
            .map(|c| AcpAvailableCommand {
                name: c.name,
                description: c.description,
                input_hint: c.input_hint,
            })
            .collect())
    }
```

- [ ] **Step 5: Implement `send_slash_command`**

```rust
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
```

- [ ] **Step 6: Implement `list_sessions`**

```rust
    async fn list_sessions(
        &self,
        current: &AmuxSessionId,
    ) -> Result<Vec<(AmuxSessionId, bool)>, AcpError> {
        let map = self.logical_to_acp.lock().await;
        Ok(map.keys().map(|k| (k.clone(), k == current)).collect())
    }
```

- [ ] **Step 7: Implement `list_agents` and `set_agent`**

```rust
    async fn list_agents(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<(String, bool)>, AcpError> {
        let current = {
            let overrides = self.agent_type_override.lock().await;
            overrides
                .get(session.as_str())
                .copied()
                .or(self.default_agent_type)
                .unwrap_or(amux::AgentType::ClaudeCode)
        };
        Ok(vec![
            (
                "claude-code".to_string(),
                current == amux::AgentType::ClaudeCode,
            ),
            (
                "opencode".to_string(),
                current == amux::AgentType::Opencode,
            ),
            ("codex".to_string(), current == amux::AgentType::Codex),
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
            other => {
                return Err(AcpError::Send(format!(
                    "unknown agent type '{other}'; valid: claude-code, opencode, codex"
                )))
            }
        };
        {
            let mut overrides = self.agent_type_override.lock().await;
            overrides.insert(session.to_string(), t);
        }
        let _ = self.cancel(session).await;
        let mut map = self.logical_to_acp.lock().await;
        map.remove(session);
        Ok(())
    }
```

Note: `amux::AgentType` values are proto-generated i32 newtype wrappers. Use the associated constants: `amux::AgentType::CLAUDE_CODE` etc. If the compiler disagrees, check what the proto generated with `grep -n "CLAUDE_CODE\|ClaudeCode" apps/daemon/src/proto/amux*.rs` and adjust accordingly.

- [ ] **Step 8: Implement `list_workspaces` and `set_workspace`**

Add a `workspace_override: Arc<Mutex<HashMap<String, String>>>` field (workspace_id keyed by logical session_id) — but first check if adding yet another field would be cleaner as a combined "session overrides" struct. For now, add it directly to `AmuxdAcpHandle`:

In struct definition, after `workspaces_path`, add:
```rust
    /// Per-session workspace override: logical_session_id → workspace_id.
    pub workspace_override: Arc<Mutex<HashMap<String, String>>>,
```

Wire it in `server.rs` constructor:
```rust
            workspace_override: Arc::new(AsyncMutex::new(HashMap::new())),
```

Wire it in `make_handle()` test helper:
```rust
            workspace_override: Arc::new(Mutex::new(HashMap::new())),
```

Then implement the methods:

```rust
    async fn list_workspaces(
        &self,
        session: &AmuxSessionId,
    ) -> Result<Vec<(String, String, bool)>, AcpError> {
        use crate::config::WorkspaceStore;
        let store = WorkspaceStore::load(&self.workspaces_path)
            .map_err(|e| AcpError::Send(format!("workspace load: {e}")))?;
        let current_id = {
            let overrides = self.workspace_override.lock().await;
            overrides
                .get(session.as_str())
                .cloned()
                .or_else(|| store.default_workspace_id.clone())
        };
        Ok(store
            .workspaces
            .iter()
            .map(|w| {
                let is_current = current_id.as_deref() == Some(&w.workspace_id);
                (w.workspace_id.clone(), w.display_name.clone(), is_current)
            })
            .collect())
    }

    async fn set_workspace(
        &self,
        session: &AmuxSessionId,
        workspace_id: &str,
    ) -> Result<(), AcpError> {
        use crate::config::WorkspaceStore;
        // Validate the workspace exists.
        let store = WorkspaceStore::load(&self.workspaces_path)
            .map_err(|e| AcpError::Send(format!("workspace load: {e}")))?;
        if !store.workspaces.iter().any(|w| w.workspace_id == workspace_id) {
            return Err(AcpError::Send(format!(
                "workspace '{workspace_id}' not found"
            )));
        }
        {
            let mut overrides = self.workspace_override.lock().await;
            overrides.insert(session.to_string(), workspace_id.to_string());
        }
        let _ = self.cancel(session).await;
        let mut map = self.logical_to_acp.lock().await;
        map.remove(session);
        Ok(())
    }
```

- [ ] **Step 9: Verify compilation**

```bash
CI=1 node scripts/rust-cli.js check 2>&1 | grep "^error" | head -20
```

Expected: zero errors (or only pre-existing unrelated errors in other crates).

- [ ] **Step 10: Run existing daemon tests**

```bash
pnpm daemon:test 2>&1 | tail -20
```

Expected: same pass/fail ratio as before this change (pre-existing failures are OK).

- [ ] **Step 11: Commit**

```bash
git add apps/daemon/src/channels/acp_handle.rs apps/daemon/src/daemon/server.rs
git commit -m "feat(daemon): implement AcpHandle slash-command + session/agent/workspace methods"
```

---

## Task 4: Create `commands.rs` module

**Files:**
- Create: `crates/teamclaw-gateway/src/commands.rs`
- Modify: `crates/teamclaw-gateway/src/lib.rs`

- [ ] **Step 1: Write failing unit tests first**

Create `crates/teamclaw-gateway/src/commands.rs` with the tests:

```rust
use crate::acp::{AcpAvailableCommand, AcpError, AcpHandle, AcpTurnOutcome, AmuxSessionId, ModelInfo};
use crate::channel_store::ChannelStore;

// ── parse_slash ──────────────────────────────────────────────────────────────

/// Parse a slash command from raw message text.
/// Returns `Some((name, arg))` if text starts with `/`, else `None`.
/// `name` is lowercase. `arg` is `Some(trimmed)` only if non-empty.
pub fn parse_slash(text: &str) -> Option<(String, Option<String>)> {
    let t = text.trim();
    if !t.starts_with('/') {
        return None;
    }
    let body = &t[1..]; // strip leading '/'
    let (name, rest) = match body.split_once(' ') {
        Some((n, r)) => (n, r.trim()),
        None => (body, ""),
    };
    if name.is_empty() {
        return None; // bare "/" or "/ " is not a command
    }
    let arg = if rest.is_empty() { None } else { Some(rest.to_string()) };
    Some((name.to_lowercase(), arg))
}

// ── MetaCommand ──────────────────────────────────────────────────────────────

enum MetaCommand {
    Help,
    Model(Option<String>),
    Sessions(Option<String>),
    Agents(Option<String>),
    Workspaces(Option<String>),
    Clear,
    Stop,
    Ctx(String),
}

fn parse_meta(name: &str, arg: Option<&str>) -> Option<MetaCommand> {
    match name {
        "help" => Some(MetaCommand::Help),
        "model" => Some(MetaCommand::Model(arg.map(str::to_string))),
        "sessions" => Some(MetaCommand::Sessions(arg.map(str::to_string))),
        "agents" => Some(MetaCommand::Agents(arg.map(str::to_string))),
        "workspaces" => Some(MetaCommand::Workspaces(arg.map(str::to_string))),
        "clear" => Some(MetaCommand::Clear),
        "stop" => Some(MetaCommand::Stop),
        "ctx" => match arg {
            Some(t) if !t.is_empty() => Some(MetaCommand::Ctx(t.to_string())),
            _ => None, // missing required arg — handled by caller
        },
        _ => None,
    }
}

const HELP_TEXT: &str = "\
Available commands:
/help - Show this help
/model [name] - List or switch models
/sessions [id] - List or switch sessions
/agents [type] - List or switch agent type
/workspaces [id] - List or switch workspace
/clear - Start new session
/stop - Stop current processing
/ctx <text> - Inject context without reply";

// ── dispatch ─────────────────────────────────────────────────────────────────

/// Dispatch a slash command.
///
/// Priority: ACP agent-reported commands first, gateway meta-commands second.
/// Calls `reply` once with the response text. Returns `Ok(true)` if a command
/// was handled, `Ok(false)` if the name was unknown (caller may send the
/// unknown-command message itself).
pub async fn dispatch<A, S>(
    name: &str,
    arg: Option<&str>,
    acp: &A,
    _store: &S,
    session: &AmuxSessionId,
    reply: impl Fn(String) + Send,
) -> Result<bool, AcpError>
where
    A: AcpHandle + Send + Sync,
    S: ChannelStore + Send + Sync,
{
    // 1. ACP agent commands take priority.
    let agent_cmds = acp.available_commands(session).await?;
    if agent_cmds.iter().any(|c| c.name.to_lowercase() == name) {
        let outcome = acp.send_slash_command(session, name, arg).await?;
        reply(outcome.reply_text);
        return Ok(true);
    }

    // 2. Gateway meta-commands.
    match name {
        "ctx" if arg.map(|a| a.is_empty()).unwrap_or(true) => {
            reply("Usage: /ctx <text>".to_string());
            return Ok(true);
        }
        _ => {}
    }

    let Some(meta) = parse_meta(name, arg) else {
        return Ok(false);
    };

    let response = match meta {
        MetaCommand::Help => HELP_TEXT.to_string(),

        MetaCommand::Model(None) => {
            let models = acp.list_models().await?;
            if models.is_empty() {
                "No models available.".to_string()
            } else {
                let lines: Vec<String> = models
                    .iter()
                    .map(|m| format!("  {}/{}", m.provider, m.model))
                    .collect();
                format!("Models:\n{}", lines.join("\n"))
            }
        }
        MetaCommand::Model(Some(name_arg)) => {
            let (provider, model) = match name_arg.split_once('/') {
                Some((p, m)) => (p.to_string(), m.to_string()),
                None => ("anthropic".to_string(), name_arg.clone()),
            };
            acp.set_model(session, &provider, &model).await?;
            format!("Model set: {}/{}", provider, model)
        }

        MetaCommand::Sessions(None) => {
            let sessions = acp.list_sessions(session).await?;
            if sessions.is_empty() {
                "No sessions.".to_string()
            } else {
                let lines: Vec<String> = sessions
                    .iter()
                    .map(|(id, cur)| {
                        if *cur {
                            format!("* {} (current)", id)
                        } else {
                            format!("  {}", id)
                        }
                    })
                    .collect();
                format!("Sessions:\n{}", lines.join("\n"))
            }
        }
        MetaCommand::Sessions(Some(id)) => {
            // Switching sessions is recorded on the AcpHandle level; the
            // gateway binding for this chat continues to use `session` as its
            // logical id, so we can only note the switch in a best-effort way.
            // Full session-switching requires a ChannelStore update which is
            // out of scope for v1.
            format!("Session: {}", id)
        }

        MetaCommand::Agents(None) => {
            let agents = acp.list_agents(session).await?;
            let lines: Vec<String> = agents
                .iter()
                .map(|(t, cur)| {
                    if *cur {
                        format!("* {} (current)", t)
                    } else {
                        format!("  {}", t)
                    }
                })
                .collect();
            format!("Agents:\n{}", lines.join("\n"))
        }
        MetaCommand::Agents(Some(agent_type)) => {
            acp.set_agent(session, &agent_type).await?;
            format!("Agent set: {}", agent_type)
        }

        MetaCommand::Workspaces(None) => {
            let workspaces = acp.list_workspaces(session).await?;
            if workspaces.is_empty() {
                "No workspaces.".to_string()
            } else {
                let lines: Vec<String> = workspaces
                    .iter()
                    .map(|(id, name, cur)| {
                        if *cur {
                            format!("* {} — {} (current)", id, name)
                        } else {
                            format!("  {} — {}", id, name)
                        }
                    })
                    .collect();
                format!("Workspaces:\n{}", lines.join("\n"))
            }
        }
        MetaCommand::Workspaces(Some(ws_id)) => {
            acp.set_workspace(session, &ws_id).await?;
            format!("Workspace: {}", ws_id)
        }

        MetaCommand::Clear => {
            acp.reset_session(session).await?;
            "Session cleared.".to_string()
        }

        MetaCommand::Stop => match acp.cancel(session).await {
            Ok(_) => "Stopped.".to_string(),
            Err(AcpError::Send(e)) if e.contains("nothing") || e.contains("no agent") => {
                "Nothing running.".to_string()
            }
            Err(e) => return Err(e),
        },

        MetaCommand::Ctx(text) => {
            acp.inject_context(session, "user", &text).await?;
            "Context injected.".to_string()
        }
    };

    reply(response);
    Ok(true)
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_slash tests ────────────────────────────────────────────────────

    #[test]
    fn parse_slash_basic() {
        assert_eq!(
            parse_slash("/help"),
            Some(("help".to_string(), None))
        );
    }

    #[test]
    fn parse_slash_with_arg() {
        assert_eq!(
            parse_slash("/model gpt-4"),
            Some(("model".to_string(), Some("gpt-4".to_string())))
        );
    }

    #[test]
    fn parse_slash_preserves_arg_case() {
        let (name, arg) = parse_slash("/ctx Hello World").unwrap();
        assert_eq!(name, "ctx");
        assert_eq!(arg.as_deref(), Some("Hello World"));
    }

    #[test]
    fn parse_slash_lowercases_name() {
        let (name, _) = parse_slash("/STOP").unwrap();
        assert_eq!(name, "stop");
    }

    #[test]
    fn parse_slash_trims_whitespace() {
        assert_eq!(
            parse_slash("  /help  "),
            Some(("help".to_string(), None))
        );
    }

    #[test]
    fn parse_slash_bare_slash_is_none() {
        assert_eq!(parse_slash("/"), None);
        assert_eq!(parse_slash("/  "), None);
    }

    #[test]
    fn parse_slash_non_command_is_none() {
        assert_eq!(parse_slash("hello"), None);
        assert_eq!(parse_slash(""), None);
        assert_eq!(parse_slash("model gpt-4"), None);
    }

    #[test]
    fn parse_slash_multiword_arg() {
        let (name, arg) = parse_slash("/ctx inject this whole sentence").unwrap();
        assert_eq!(name, "ctx");
        assert_eq!(arg.as_deref(), Some("inject this whole sentence"));
    }

    // ── dispatch tests ───────────────────────────────────────────────────────

    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    struct MockAcp {
        available: Vec<AcpAvailableCommand>,
        last_reply: StdMutex<Option<String>>,
        cancel_returns_nothing: bool,
    }

    impl MockAcp {
        fn new(available: Vec<AcpAvailableCommand>) -> Self {
            Self {
                available,
                last_reply: StdMutex::new(None),
                cancel_returns_nothing: false,
            }
        }
        fn nothing_running() -> Self {
            Self {
                available: vec![],
                last_reply: StdMutex::new(None),
                cancel_returns_nothing: true,
            }
        }
    }

    #[async_trait]
    impl AcpHandle for MockAcp {
        async fn create_session(&self, _: &str, b: &str, _: &str) -> Result<AmuxSessionId, AcpError> {
            Ok(b.to_string())
        }
        async fn send_prompt(&self, _: &AmuxSessionId, _: &str, text: &str) -> Result<AcpTurnOutcome, AcpError> {
            Ok(AcpTurnOutcome { reply_text: format!("echo:{text}"), completed: true })
        }
        async fn inject_context(&self, _: &AmuxSessionId, _: &str, _: &str) -> Result<(), AcpError> {
            Ok(())
        }
        async fn cancel(&self, _: &AmuxSessionId) -> Result<(), AcpError> {
            if self.cancel_returns_nothing {
                Err(AcpError::Send("no agent".to_string()))
            } else {
                Ok(())
            }
        }
        async fn reset_session(&self, _: &AmuxSessionId) -> Result<(), AcpError> { Ok(()) }
        async fn list_models(&self) -> Result<Vec<ModelInfo>, AcpError> {
            Ok(vec![ModelInfo {
                provider: "anthropic".to_string(),
                model: "sonnet".to_string(),
                display_name: "Sonnet".to_string(),
            }])
        }
        async fn set_model(&self, _: &AmuxSessionId, _: &str, _: &str) -> Result<(), AcpError> { Ok(()) }
        async fn available_commands(&self, _: &AmuxSessionId) -> Result<Vec<AcpAvailableCommand>, AcpError> {
            Ok(self.available.clone())
        }
        async fn send_slash_command(&self, _: &AmuxSessionId, name: &str, input: Option<&str>) -> Result<AcpTurnOutcome, AcpError> {
            let text = match input {
                Some(i) => format!("/{name} {i}"),
                None => format!("/{name}"),
            };
            Ok(AcpTurnOutcome { reply_text: format!("agent:{text}"), completed: true })
        }
        async fn list_sessions(&self, current: &AmuxSessionId) -> Result<Vec<(AmuxSessionId, bool)>, AcpError> {
            Ok(vec![(current.clone(), true)])
        }
        async fn list_agents(&self, _: &AmuxSessionId) -> Result<Vec<(String, bool)>, AcpError> {
            Ok(vec![("claude-code".to_string(), true)])
        }
        async fn set_agent(&self, _: &AmuxSessionId, _: &str) -> Result<(), AcpError> { Ok(()) }
        async fn list_workspaces(&self, _: &AmuxSessionId) -> Result<Vec<(String, String, bool)>, AcpError> {
            Ok(vec![("ws-1".to_string(), "My WS".to_string(), true)])
        }
        async fn set_workspace(&self, _: &AmuxSessionId, _: &str) -> Result<(), AcpError> { Ok(()) }
    }

    struct MockStore;
    #[async_trait]
    impl ChannelStore for MockStore {
        async fn ensure_external_actor(&self, _: &str, _: &str, _: &str) -> Result<String, crate::channel_store::ChannelStoreError> { Ok("actor".to_string()) }
        async fn ensure_session(&self, _: &str, _: &str, _: &str, _: &str, _: &[String], _: &[String]) -> Result<crate::channel_store::EnsureSessionOutcome, crate::channel_store::ChannelStoreError> {
            Ok(crate::channel_store::EnsureSessionOutcome { session_id: "sess".to_string(), acp_session_id: "acp".to_string() })
        }
        async fn record_message(&self, _: &str, _: &str, _: &str, _: &str) -> Result<(), crate::channel_store::ChannelStoreError> { Ok(()) }
        async fn record_message_with_attachments(&self, _: &str, _: &str, _: &str, _: &str, _: Vec<crate::channel_store::AttachmentRecord>) -> Result<(), crate::channel_store::ChannelStoreError> { Ok(()) }
        async fn upload_attachment(&self, _: &str, _: Vec<u8>, _: &str) -> Result<String, crate::channel_store::ChannelStoreError> { Ok("url".to_string()) }
        async fn add_participant(&self, _: &str, _: &str) -> Result<(), crate::channel_store::ChannelStoreError> { Ok(()) }
    }

    async fn collect_reply(
        name: &str,
        arg: Option<&str>,
        acp: &MockAcp,
    ) -> (bool, String) {
        let session = "sess-test".to_string();
        let store = MockStore;
        let mut out = String::new();
        let handled = dispatch(name, arg, acp, &store, &session, |r| out = r)
            .await
            .unwrap();
        (handled, out)
    }

    #[tokio::test]
    async fn help_returns_all_commands() {
        let acp = MockAcp::new(vec![]);
        let (handled, reply) = collect_reply("help", None, &acp).await;
        assert!(handled);
        assert!(reply.contains("/help"), "reply: {reply}");
        assert!(reply.contains("/model"), "reply: {reply}");
        assert!(reply.contains("/clear"), "reply: {reply}");
        assert!(reply.contains("/ctx"), "reply: {reply}");
    }

    #[tokio::test]
    async fn model_list_no_arg() {
        let acp = MockAcp::new(vec![]);
        let (handled, reply) = collect_reply("model", None, &acp).await;
        assert!(handled);
        assert!(reply.contains("anthropic/sonnet"), "reply: {reply}");
    }

    #[tokio::test]
    async fn model_set_with_arg() {
        let acp = MockAcp::new(vec![]);
        let (handled, reply) = collect_reply("model", Some("anthropic/opus"), &acp).await;
        assert!(handled);
        assert!(reply.contains("Model set"), "reply: {reply}");
    }

    #[tokio::test]
    async fn clear_resets_session() {
        let acp = MockAcp::new(vec![]);
        let (handled, reply) = collect_reply("clear", None, &acp).await;
        assert!(handled);
        assert_eq!(reply, "Session cleared.");
    }

    #[tokio::test]
    async fn stop_when_running() {
        let acp = MockAcp::new(vec![]);
        let (handled, reply) = collect_reply("stop", None, &acp).await;
        assert!(handled);
        assert_eq!(reply, "Stopped.");
    }

    #[tokio::test]
    async fn stop_when_nothing_running() {
        let acp = MockAcp::nothing_running();
        let (handled, reply) = collect_reply("stop", None, &acp).await;
        assert!(handled);
        assert_eq!(reply, "Nothing running.");
    }

    #[tokio::test]
    async fn ctx_missing_arg_shows_usage() {
        let acp = MockAcp::new(vec![]);
        let (handled, reply) = collect_reply("ctx", None, &acp).await;
        assert!(handled);
        assert!(reply.contains("Usage:"), "reply: {reply}");
    }

    #[tokio::test]
    async fn ctx_with_arg_injects_context() {
        let acp = MockAcp::new(vec![]);
        let (handled, reply) = collect_reply("ctx", Some("some background"), &acp).await;
        assert!(handled);
        assert_eq!(reply, "Context injected.");
    }

    #[tokio::test]
    async fn unknown_command_returns_false() {
        let acp = MockAcp::new(vec![]);
        let (handled, _) = collect_reply("foobar", None, &acp).await;
        assert!(!handled);
    }

    #[tokio::test]
    async fn acp_command_takes_priority_over_meta() {
        // Agent reports /clear — its reply should win over meta /clear.
        let acp = MockAcp::new(vec![AcpAvailableCommand {
            name: "clear".to_string(),
            description: "agent clear".to_string(),
            input_hint: String::new(),
        }]);
        let (handled, reply) = collect_reply("clear", None, &acp).await;
        assert!(handled);
        // MockAcp.send_slash_command returns "agent:/clear"
        assert!(reply.starts_with("agent:"), "expected agent reply, got: {reply}");
    }
}
```

- [ ] **Step 2: Run the tests — expect compile errors (trait not yet in scope)**

```bash
CI=1 node scripts/rust-cli.js test teamclaw-gateway 2>&1 | grep "^error" | head -20
```

Adjust imports if needed. The `ChannelStore` mock may need to match the actual trait signature — check `crates/teamclaw-gateway/src/channel_store.rs` and update `MockStore` accordingly.

- [ ] **Step 3: Add `pub mod commands` to `lib.rs`**

In `crates/teamclaw-gateway/src/lib.rs`, find the `pub mod` block and add:

```rust
pub mod commands;
```

- [ ] **Step 4: Run tests and iterate until green**

```bash
CI=1 node scripts/rust-cli.js test teamclaw-gateway 2>&1 | tail -30
```

Expected: all tests in `commands.rs` pass.

- [ ] **Step 5: Commit**

```bash
git add crates/teamclaw-gateway/src/commands.rs crates/teamclaw-gateway/src/lib.rs
git commit -m "feat(gateway): add commands module with parse_slash + dispatch"
```

---

## Task 5: Wire into wecom.rs

**Files:**
- Modify: `crates/teamclaw-gateway/src/wecom.rs`

- [ ] **Step 1: Add import at top of wecom.rs**

Find the existing `use` block at the top of `wecom.rs` and add:

```rust
use crate::commands;
```

- [ ] **Step 2: Replace the existing ad-hoc dispatch block**

Find the section (around line 1378–1393):

```rust
        // Slash-command dispatch — /stop /reset /model — against the resolved session.
        let trimmed_for_cmd = text_content.trim();
        if trimmed_for_cmd.starts_with('/') {
            let lower = trimmed_for_cmd.to_lowercase();
            if lower == "/stop"
                || lower == "/reset"
                || lower == "/model"
                || lower.starts_with("/model ")
            {
                let reply_text = self
                    .dispatch_session_slash_cmd(&lower, &outcome.acp_session_id)
                    .await;
                let _ = self.send_reply(&req_id, &reply_text, &ws_sink).await;
                return;
            }
        }
```

Replace it with:

```rust
        // Slash-command dispatch — two-layer: ACP agent commands first, then
        // gateway meta-commands (/help, /model, /sessions, /agents,
        // /workspaces, /clear, /stop, /ctx).
        if let Some((cmd_name, cmd_arg)) = commands::parse_slash(text_content.trim()) {
            let acp = self.acp.as_ref();
            let store = self.store.as_ref();
            let session = outcome.acp_session_id.clone();
            let ws = ws_sink.clone();
            let req = req_id.clone();
            let self_ref = self.clone_for_send();
            let handled = commands::dispatch(
                &cmd_name,
                cmd_arg.as_deref(),
                acp,
                store,
                &session,
                move |reply| {
                    let ws2 = ws.clone();
                    let req2 = req.clone();
                    let s = self_ref.clone();
                    tokio::spawn(async move {
                        let _ = s.send_reply(&req2, &reply, &ws2).await;
                    });
                },
            )
            .await;
            match handled {
                Ok(true) => return,
                Ok(false) => {
                    let _ = self
                        .send_reply(
                            &req_id,
                            &format!("Unknown command: /{cmd_name}. Send /help for list."),
                            &ws_sink,
                        )
                        .await;
                    return;
                }
                Err(e) => {
                    let _ = self
                        .send_reply(&req_id, &format!("Command error: {e}"), &ws_sink)
                        .await;
                    return;
                }
            }
        }
```

**Note on `self.clone_for_send()`:** The closure needs a way to call `send_reply`. Check whether `WeComGateway` (or whatever the containing struct is) implements `Clone`. If not, extract just the needed fields:

```rust
            // Alternative if Clone isn't available — capture individual fields:
            let ws = ws_sink.clone();
            let req = req_id.to_string();
            let acp2 = self.acp.clone();   // if acp is Arc<dyn AcpHandle>
            // ... etc, check actual field types
```

Adjust to whatever the struct allows. The key invariant: reply must be sent asynchronously without holding any locks.

- [ ] **Step 3: Remove `dispatch_session_slash_cmd` and the redundant `handle_slash_command`**

Delete (or replace with a comment marking them as superseded) both methods:
- `dispatch_session_slash_cmd` (line ~1587)
- `handle_slash_command` (line ~1642) — this also handled `/help` via i18n; the new `commands::dispatch` handles `/help` directly. Check if the caller of `handle_slash_command` is still needed; remove or update it.

Find all callers of `handle_slash_command` in `wecom.rs`:

```bash
grep -n "handle_slash_command\|dispatch_session_slash_cmd" crates/teamclaw-gateway/src/wecom.rs
```

Remove or update each caller.

- [ ] **Step 4: Compile check**

```bash
CI=1 node scripts/rust-cli.js check 2>&1 | grep "^error" | head -20
```

Expected: zero errors.

- [ ] **Step 5: Run full unit tests**

```bash
CI=1 node scripts/rust-cli.js test teamclaw-gateway 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add crates/teamclaw-gateway/src/wecom.rs
git commit -m "feat(wecom): replace ad-hoc slash dispatch with generic commands::dispatch"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full Rust check**

```bash
CI=1 node scripts/rust-cli.js check 2>&1 | grep "^error"
```

Expected: no errors.

- [ ] **Step 2: Run all daemon tests**

```bash
pnpm daemon:test 2>&1 | tail -30
```

Expected: pre-existing failures only (daemon tests have known unrelated failures on main).

- [ ] **Step 3: Run gateway unit tests**

```bash
CI=1 node scripts/rust-cli.js test teamclaw-gateway 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 4: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore(gateway): cleanup after channel commands implementation"
```

---

## Known Caveats

- **`/sessions <id>` switching** is listed in spec but is partially a stub in v1 — it replies `"Session: <id>"` but does not actually reroute the gateway binding. Full switching requires a `ChannelStore.switch_session()` method not in scope here.
- **wecom.rs `self.clone_for_send()`** — the exact closure pattern depends on whether `WeComGateway` is `Clone`. Task 5 Step 2 contains the adjustment note.
- **Proto AgentType constants** — generated names may be `AgentType::CLAUDE_CODE` (screaming snake) rather than `AgentType::ClaudeCode`. Verify with `grep -r "CLAUDE_CODE\|ClaudeCode" apps/daemon/src/proto/` and use whatever the codegen produced.
