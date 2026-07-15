# Remote Tools MCP

Agent-side tools that execute on the TeamClaw **client** (Chrome extension, future desktop/iOS) via MQTT RPC.

## Architecture

```
Agent → amuxd remote-tools-mcp (stdio) → daemon.sock → remote_context_id lookup
  → MQTT amux/{team}/{memberActor}/rpc/req
  → all online clients for that member actor → capable client replies, others stay silent
```

- **Daemon** installs `amuxd-remote-tools` as a host-level MCP baseline before OpenCode/Codex hosts start.
- **Agent** receives a per-turn `remote_context_id` instruction and must include it in remote-tool calls.
- **packages/app** listens on `amux/{team}/{myActorId}/rpc/req`; clients without an executor **do not reply**.
- **Extension** registers `get_page_dom` executor locally.

## Routing

1. Prompt start creates a short-lived `remote_context_id` for `(runtime, ACP session, team, member actor)`.
2. The next prompt injects instructions telling the model to pass that exact `remote_context_id`.
3. MCP invoke resolves `remote_context_id` to the current member actor.
4. Daemon publishes one RPC to `amux/{team}/{memberActor}/rpc/req`.

### Security

- **MQTT ACL**: members `SUB` own `rpc/req`; agents `PUB` to `amux/{team}/+/rpc/req` (migration `20260706120000_member_sub_own_rpc_req.sql`). Deploy migration before clients.
- **Client validation**: `packages/app` rejects `RemoteToolInvoke` unless `requester_actor_id` is a session agent **and** participants are loaded (fail-closed). Extension/web loads participants via Cloud API (`sessionMembers.listParticipants`); desktop uses libsql cache. The RPC handler calls `ensureParticipants` before validating.

### Multi-member sessions

When Bob sends a turn, that turn's `remote_context_id` routes to Bob. When Alice later sends a turn in the same agent session, her turn gets a different `remote_context_id` and routes to Alice. The MCP server stays shared at host level; only the tool-call argument selects the target client.

### ACP host reuse

OpenCode/Codex keep a process-level MCP registry, so remote-tools MCP must not be refreshed by per-session ACP resume. The daemon ensures the host starts in the workspace with the inherent MCP config present; `session/resume` does not reattach remote-tools MCP. Host reuse for OpenCode/Codex is keyed by workspace path to avoid cross-workspace registry pollution.

## Adding a tool

1. `apps/daemon/src/remote_tools/registry.rs` — name, description (include supported clients), schema
2. `packages/app/src/lib/remote-tools/` — executor + `registerPlatformExecutors`
3. (if browser DOM) `apps/extension/src/lib/browser-tools/`
4. Tests + smoke in extension session

## Phase 1

- Tool: `get_page_dom` (`mode`: `outline` | `text`, `max_chars` default 8000)
- Tool: `show_page_nav_links` (`links`: string[], optional `labels`: string[])
  - **Daemon-local**: returns immediately; no MQTT/extension roundtrip during invoke
  - Chat UI renders buttons from tool-call arguments in the ACP transcript
  - Button click navigates active tab (extension only)
  - Same-origin targets use `history.pushState` + `popstate` for SPA in-app routing; cross-origin uses tab navigation
- Description notes: `Supported clients: chrome-extension`
