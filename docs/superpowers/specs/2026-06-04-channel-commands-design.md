# Channel Slash Commands — Design Spec

**Date:** 2026-06-04
**Branch:** to be created from main
**Scope:** `crates/teamclaw-gateway` (+ `acp.rs` trait extension)

## Overview

Add a universal slash-command system to the `teamclaw-gateway` crate so every channel gateway (WeChat Work, Discord, Feishu, etc.) can interpret `/command` messages from users without each gateway implementing its own parser.

## Commands

| Command | Arguments | Description |
|---------|-----------|-------------|
| `/help` | — | Print available commands |
| `/model` | `[name]` | No arg: list models with current marked `*`. With arg: switch model. |
| `/sessions` | `[id]` | No arg: list ACP sessions with current marked `*`. With arg: switch to that session. |
| `/agents` | `[type]` | No arg: list agent types with current marked `*`. With arg: set agent type. |
| `/workspaces` | `[id]` | No arg: list workspaces with current marked `*`. With arg: set workspace. |
| `/clear` | — | Reset the current ACP session (start fresh) |
| `/stop` | — | Cancel in-progress ACP generation |
| `/ctx` | `<text>` | Inject context without triggering a reply |

Unknown commands reply: `Unknown command. /help for list.`
Missing required argument replies: `Usage: /ctx <text>`

## Architecture

### Two-layer dispatch

Commands are dispatched in priority order:

1. **ACP agent commands** — the agent has reported this command via `AcpAvailableCommands`. Forward to ACP via `send_slash_command()`. The agent handles it and replies.
2. **Gateway meta commands** — fallback if ACP has no matching command. Handled locally by `dispatch_command()`.

This means if an ACP agent reports `/clear`, its `/clear` wins over the gateway's built-in `/clear`. Gateway meta commands only fire when the agent doesn't know the command.

### New file: `crates/teamclaw-gateway/src/commands.rs`

**Public API:**

```rust
/// Returns Some((name, arg)) if text starts with '/', None otherwise.
/// arg is the remainder after the command name, trimmed.
pub fn parse_slash(text: &str) -> Option<(String, Option<String>)>

/// Dispatch a slash command. Checks ACP agent commands first, falls back
/// to gateway meta commands. Calls `reply` with the response string.
pub async fn dispatch<S, A>(
    name: &str,
    arg: Option<&str>,
    acp: &A,
    store: &S,
    session_id: &AmuxSessionId,
    reply: impl Fn(String) + Send,
) -> anyhow::Result<()>
where
    A: AcpHandle + Send + Sync,
    S: ChannelStore + Send + Sync,
```

**Gateway meta command enum (internal):**

```rust
enum MetaCommand {
    Help,
    Model(Option<String>),      // None = list, Some(name) = switch
    Sessions(Option<String>),   // None = list, Some(id) = switch
    Agents(Option<String>),     // None = list, Some(type) = set
    Workspaces(Option<String>), // None = list, Some(id) = set
    Clear,
    Stop,
    Ctx(String),
}
```

### `acp.rs` trait extension

Add `list_sessions` to `AcpHandle`:

```rust
/// List all ACP sessions. Returns (session_id, is_current) pairs.
async fn list_sessions(&self) -> Result<Vec<(AmuxSessionId, bool)>, AcpError>;
```

Also add `send_slash_command` for forwarding ACP agent commands:

```rust
/// Forward a slash command to the ACP agent. Used when the agent has
/// reported this command via AcpAvailableCommands. Returns the agent's
/// reply text (same shape as send_prompt).
async fn send_slash_command(
    &self,
    session: &AmuxSessionId,
    name: &str,
    input: Option<&str>,
) -> Result<AcpTurnOutcome, AcpError>;

/// Return the slash commands the agent has currently reported, or empty
/// if none. Used by dispatch() to check ACP-first priority.
async fn available_commands(
    &self,
    session: &AmuxSessionId,
) -> Result<Vec<AcpAvailableCommand>, AcpError>;
```

The daemon's `AmuxdAcpHandle` reads `available_commands` from the cached `RuntimeInfo` (already stored in `runtime/manager.rs`).

Also add `list_sessions`, `list_agents`, `set_agent`, `list_workspaces`, `set_workspace`:

```rust
/// List available agent types. Returns (agent_type, is_current) pairs.
async fn list_agents(&self, session: &AmuxSessionId) -> Result<Vec<(String, bool)>, AcpError>;
/// Set agent type for this session.
async fn set_agent(&self, session: &AmuxSessionId, agent_type: &str) -> Result<(), AcpError>;
/// List available workspaces. Returns (workspace_id, is_current) pairs.
async fn list_workspaces(&self, session: &AmuxSessionId) -> Result<Vec<(String, bool)>, AcpError>;
/// Set workspace for this session.
async fn set_workspace(&self, session: &AmuxSessionId, workspace_id: &str) -> Result<(), AcpError>;
```

### `lib.rs` change

Add `pub mod commands;` to the module list.

### Gateway integration (wecom.rs example)

In the text-message handler, before calling `acp.send_prompt()`:

```rust
use crate::commands::{parse_command, dispatch_command};

if let Some((name, arg)) = parse_slash(&text) {
    dispatch(&name, arg.as_deref(), &acp, &store, &session_id, |reply| {
        // call existing send_text helper
        send_chat_message(&ws_sink, &chat_id, &reply).await;
    }).await?;
    return Ok(());
}
// normal ACP flow continues
```

Other gateways follow the same 3-line pattern with their own `send_text` helper.

## Command Responses (plain text)

**`/help`**
```
Available commands:
/help - Show this help
/model [name] - List or switch models
/sessions [id] - List or bind sessions
/clear - Start new session
/stop - Stop current processing
/ctx <text> - Inject context without reply
```

**`/model` (no arg)**
```
Models:
* claude-sonnet-4-6 (current)
  gpt-4o
  gemini-2.0-flash
```

**`/model gpt-4o`**
```
Model set: gpt-4o
```

**`/sessions` (no arg)**
```
Sessions:
* sess_abc123 (current)
  sess_def456
```
(data from `acp.list_sessions()`)

**`/sessions sess_def456`**
```
Session: sess_def456
```

**`/agents` (no arg)**
```
Agents:
* assistant (current)
  coder
  researcher
```

**`/agents coder`**
```
Agent set: coder
```

**`/workspaces` (no arg)**
```
Workspaces:
* ws_abc123 (current)
  ws_def456
```

**`/workspaces ws_def456`**
```
Workspace: ws_def456
```

**`/clear`**
```
Session cleared.
```

**`/stop`**
```
Stopped.
```
or if nothing running:
```
Nothing running.
```

**`/ctx <text>`**
```
Context injected.
```

## Error Handling

- Unknown command → `Unknown command. /help for list.`
- Missing required arg → `Usage: /ctx <text>`
- ACP errors (e.g., `set_model` fails) → propagate as `Err`, gateway logs and optionally replies with a generic error string
- `/stop` when nothing is running → `Nothing running.` (not an error)

## Testing

Unit tests in `commands.rs`:
- `parse_command` covers: valid commands, unknown commands, missing args, extra whitespace, non-command text
- `dispatch_command` with mock `AcpHandle` + `ChannelStore` for each command variant

## File Changes Summary

```
crates/teamclaw-gateway/src/
├── commands.rs     ← NEW: parse_command, dispatch_command, Command enum
├── acp.rs          ← add: send_slash_command, available_commands, list_sessions, list_agents, set_agent, list_workspaces, set_workspace
├── lib.rs          ← add: pub mod commands
└── wecom.rs        ← add: ~5 lines in text message handler

(other gateways: each adds ~5 lines when they need command support)
```

## Out of Scope

- Command permissions / access control
- Custom commands per workspace
- Command history
- Rich-text / card responses (WeChat Work card format)
