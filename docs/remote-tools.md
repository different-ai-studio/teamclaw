# Remote Tools MCP

Agent-side tools that execute on the TeamClaw **client** (Chrome extension, future desktop/iOS) via MQTT RPC.

## Architecture

```
Agent → amuxd remote-tools-mcp (stdio) → daemon.sock → MQTT amux/{team}/{memberActor}/rpc/req
  → all online clients for that member actor → capable client replies, others stay silent
```

- **Daemon** mounts remote MCP on session-bound `runtimeStart` when spawning a new agent process.
- **Agent** learns which tools fit the current environment from tool descriptions (and future spawn env vars).
- **packages/app** listens on `amux/{team}/{myActorId}/rpc/req`; clients without an executor **do not reply**.
- **Extension** registers `get_page_dom` executor locally.

## Routing

1. Each live runtime stores `remote_tool_member_id` — the human member whose browser/client should execute tools.
2. **New spawn**: bind to `runtimeStart` requester.
3. **Dedup / resume reuse**: rebind **only when `initial_prompt` is non-empty** (@mention engage). Passive `runtimeStart` (picker refresh, focus) does **not** steal routing.
4. Tool invoke resolves: live runtime `remote_tool_member_id` → fallback `SessionRemoteTargetStore` (30min TTL).
5. Daemon publishes one RPC to `amux/{team}/{memberActor}/rpc/req`.

### Security

- **MQTT ACL**: members `SUB` own `rpc/req`; agents `PUB` to `amux/{team}/+/rpc/req` (migration `20260706120000_member_sub_own_rpc_req.sql`). Deploy migration before clients.
- **Client validation**: `packages/app` rejects `RemoteToolInvoke` unless `requester_actor_id` is a session agent **and** participants are loaded (fail-closed). Extension/web loads participants via Cloud API (`sessionMembers.listParticipants`); desktop uses libsql cache. The RPC handler calls `ensureParticipants` before validating.

### Multi-member sessions

When Bob @mentions the agent, routing binds to Bob. When Alice later @mentions, routing rebinds to Alice. A passive `runtimeStart` from the model picker without a user message does not change the bound member.

### ACP session resume

ACP resume is never disabled for remote tools. When a per-session MCP config file exists, `session/resume` receives the same `mcp_servers` as `session/new`, so daemon restarts can restore `get_page_dom` without forcing a new agent process.

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
