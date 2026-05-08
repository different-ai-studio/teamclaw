# TeamClaw v2 — Phase 0 + 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-08-amuxd-architecture-design.md`

**Goal:** Land the foundation of TeamClaw v2 — bootable worktree, Supabase auth, MQTT bus, ChatPanel rendering by actor, and human-to-human ChatMessage round trip across two windows in the same session — and remove the OpenCode sidecar at the end.

**Architecture:** Rust-side MQTT (rumqttc, mirroring amuxd's `daemon/src/mqtt/`), Supabase JS on the frontend backed by a Tauri auth bridge for OAuth deeplinks and refresh-token persistence, Protobuf envelopes vendored from amuxd's `amux.proto` (decoded in Rust, surfaced as JSON ActorEvents to the frontend over Tauri events), single MQTT topic per session (`session/{id}/live`).

**Tech Stack:** Rust (Tauri 2, rumqttc 0.24, prost 0.13, reqwest, jsonwebtoken, tokio), TypeScript (React 19, Zustand, `@supabase/supabase-js`, `@bufbuild/protobuf`), EMQX cloud broker, Supabase project.

**Acceptance criteria for Phase 0 + 1:**
- `pnpm tauri:dev` boots in the v2 worktree without OpenCode binary
- User clicks "Login" → OAuth deeplink → Supabase session persisted → relaunch keeps user logged in
- Session list renders from Supabase (real data via `@supabase/supabase-js`)
- Click a session → frontend asks Tauri to `mqtt_subscribe(session_id)`; Rust subscribes to `session/{id}/live`
- Type a message → frontend asks Tauri to `mqtt_publish(envelope)`; Rust publishes a `ChatMessage` envelope
- A second window logged into the same Supabase user, in the same session, receives the envelope and renders the message under the publisher's actor name and avatar
- All `cargo clippy -- -D warnings`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `cargo test` clean
- All OpenCode code, binary, and `@opencode-ai/sdk` dependency removed in the final task

**Out of scope (Phase 2+ plans):**
- amuxd daemon installer, ACP `start_agent`, agent streaming, permission flow (Phase 2)
- MCP / skills / slash commands rendering, multi-actor view polish, editor coordination (Phase 3)
- v1 export tool, beta program, GA tag (Phase 4 / 5)

---

## Pre-requisites

Have these references open while implementing:

- `/Volumes/openbeta/workspace/amux/proto/amux.proto` — the canonical envelope schema; vendored to `proto/amux.proto` in v2
- `/Volumes/openbeta/workspace/amux/daemon/src/mqtt/{client,publisher,subscriber,topics}.rs` — reference implementation for `src-tauri/src/mqtt_bus/`
- `/Volumes/openbeta/workspace/amux/daemon/src/supabase/{client,config}.rs` — reference for `src-tauri/src/supabase_auth/`
- `/Volumes/openbeta/workspace/amux/daemon/src/proto.rs` — Rust prost include macro pattern
- `/Volumes/openbeta/workspace/amux/daemon/Cargo.toml` — dependency versions to mirror
- `/Volumes/openbeta/workspace/teamclaw/packages/app/src/stores/STREAMING_ARCHITECTURE.md` — single-source-of-truth contract preserved through the rewrite

---

## File Structure

| Path | Responsibility | Phase |
|---|---|---|
| `../teamclaw-v2/` (worktree) | Sibling working copy on branch `v2/amuxd-architecture` | 0.1 |
| `proto/amux.proto` | Vendored Protobuf schema (single source of truth, copied from amuxd repo) | 0.2 |
| `src-tauri/build.rs` | Adds `prost-build` step for `proto/amux.proto` | 0.2 |
| `src-tauri/src/proto.rs` | `pub mod amux { include!(concat!(env!("OUT_DIR"), "/amux.rs")); }` + encode helpers | 0.2 |
| `src-tauri/Cargo.toml` | Adds `rumqttc 0.24`, `prost 0.13`, `prost-build 0.13`, `jsonwebtoken 9`; tightens `reqwest` features | 0.4 |
| `src-tauri/src/commands/mqtt_bus.rs` | Tauri command surface: `mqtt_subscribe`, `mqtt_publish`, `mqtt_status`; emits `mqtt:envelope` to windows | 0.5 / 1B |
| `src-tauri/src/mqtt/{mod,client,topics}.rs` | Internal impl of MQTT client, mirroring amuxd. Phase 1 keeps publish/subscribe inside `client.rs`; split into separate files only if the file grows past ~400 lines. | 1B |
| `src-tauri/src/commands/supabase_auth_bridge.rs` | Tauri commands: `supabase_login`, `supabase_logout`, `supabase_get_session`, `supabase_handle_deeplink` | 0.6 / 1A |
| `src-tauri/src/supabase_auth/{mod,client,store}.rs` | OAuth state machine, token refresh, persistent storage | 1A |
| `src-tauri/src/commands/daemon_installer.rs` | Phase 2 fills this in; Phase 0 is a stub returning `not_implemented` | 0.7 |
| `src-tauri/src/lib.rs` | Registers new commands; deregisters opencode commands at end of Phase 1 | 0.5 / 1E |
| `tauri.conf.json` | Adds deeplink scheme; removes opencode external bin in Phase 1E | 1A / 1E |
| `packages/app/package.json` | Adds `@supabase/supabase-js`, `@bufbuild/protobuf`; removes `@opencode-ai/sdk` in Phase 1E | 0.8 / 1E |
| `packages/app/src/lib/proto/index.ts` | Generated TS bindings (JSON shape only — Rust does decode) | 0.3 |
| `packages/app/src/lib/actor/types.ts` | `Actor`, `ActorEvent`, `ActorType`, payload variants | 0.9 |
| `packages/app/src/lib/actor/event-mapper.ts` | Envelope JSON ↔ `ActorEvent`; pure function, full unit coverage | 0.10 |
| `packages/app/src/lib/mqtt-bridge.ts` | Wraps `invoke('mqtt_*', ...)` and `listen('mqtt:envelope', ...)` for stores | 1C |
| `packages/app/src/lib/supabase-client.ts` | Wraps `@supabase/supabase-js` + queries `sessions`, `actors`, `session_actors` | 1A.4 |
| `packages/app/src/stores/auth-store.ts` | Zustand store for current user / login state, calls `supabase_auth_bridge` | 1A.5 |
| `packages/app/src/stores/session-list-store.ts` | Zustand store for sidebar (Supabase-backed) | 1D.3 |
| `packages/app/src/stores/session-store.ts` (rewritten) | Holds `ActorEvent[]` per session; routes incoming envelopes via `event-mapper`; replaces opencode-driven version | 1D.1 |
| `packages/app/src/stores/session-event-bus.ts` | Listens to Tauri `mqtt:envelope`, fans out to per-session stores | 1C.3 |
| `packages/app/src/components/chat/ChatPanel.tsx` (modified) | Renders by actor; sidebar from `session-list-store`; messages from `session-store` | 1D.2 / 1D.4 |
| `tests/fixtures/envelopes/*.json` | Captured envelope sequences for unit tests | 0.10 |
| `~/.teamclaw/auth.json` (runtime) | Refresh token persistence (mode 0600) | 1A.3 |

**Files removed at end of Phase 1 (Task 1E.3):**
- `src-tauri/binaries/opencode-*` (all platforms)
- `src-tauri/src/commands/opencode.rs`
- `packages/app/src/lib/opencode/` (whole dir)
- `packages/app/src/stores/session-sse-{lifecycle,message,tool}-handlers.ts`
- `@opencode-ai/sdk` from `packages/app/package.json`
- `binaries/opencode` entry from `tauri.conf.json` `externalBin`

---

## Phase 0 — Setup

### Task 0.1: Create v2 worktree

**Files:**
- New worktree directory: `../teamclaw-v2/`
- New branch: `v2/amuxd-architecture`

- [ ] **Step 1: Verify clean main**

Run: `git -C /Volumes/openbeta/workspace/teamclaw status --short`
Expected: empty output (clean tree).

- [ ] **Step 2: Create worktree on new branch**

Run:
```bash
git -C /Volumes/openbeta/workspace/teamclaw worktree add ../teamclaw-v2 -b v2/amuxd-architecture
```
Expected: `Preparing worktree (new branch 'v2/amuxd-architecture')` and `HEAD is now at <sha>`.

- [ ] **Step 3: Verify worktree**

Run: `git -C /Volumes/openbeta/workspace/teamclaw-v2 branch --show-current`
Expected: `v2/amuxd-architecture`.

- [ ] **Step 4: Install dependencies in worktree**

Run: `cd /Volumes/openbeta/workspace/teamclaw-v2 && pnpm install --frozen-lockfile`
Expected: install succeeds.

- [ ] **Step 5: Smoke build**

Run: `cd /Volumes/openbeta/workspace/teamclaw-v2 && pnpm rust:check && pnpm typecheck`
Expected: both succeed (this is the v1 baseline; subsequent tasks must keep this green until Task 1E).

> **All file paths in tasks below are relative to `/Volumes/openbeta/workspace/teamclaw-v2/` unless stated otherwise.**

---

### Task 0.2: Vendor `amux.proto` and wire prost build

**Files:**
- Create: `proto/amux.proto` (copy from `/Volumes/openbeta/workspace/amux/proto/amux.proto`)
- Modify: `src-tauri/build.rs`
- Create: `src-tauri/src/proto.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod proto;`)

- [ ] **Step 1: Copy proto file**

Run:
```bash
mkdir -p proto
cp /Volumes/openbeta/workspace/amux/proto/amux.proto proto/amux.proto
```
Expected: `proto/amux.proto` exists, ~10 KB.

- [ ] **Step 2: Add prost-build to `src-tauri/Cargo.toml`**

In `[build-dependencies]` section, add:
```toml
prost-build = "0.13"
```

- [ ] **Step 3: Add prost runtime dep**

In `[dependencies]`:
```toml
prost = "0.13"
prost-types = "0.13"
```

- [ ] **Step 4: Read existing build.rs**

Run: `cat src-tauri/build.rs`
Expected: existing tauri-build invocation. Note its contents to preserve them.

- [ ] **Step 5: Append prost-build invocation to build.rs**

Add to the end of `src-tauri/build.rs` (preserving the existing tauri-build call):
```rust
fn compile_protos() {
    let proto = "../proto/amux.proto";
    println!("cargo:rerun-if-changed={proto}");
    prost_build::Config::new()
        .compile_protos(&[proto], &["../proto"])
        .expect("compile amux.proto");
}
```
And call `compile_protos();` from `main()` before / after the existing `tauri_build::build()`.

- [ ] **Step 6: Create `src-tauri/src/proto.rs`**

```rust
pub mod amux {
    include!(concat!(env!("OUT_DIR"), "/amux.rs"));
}

use prost::Message;

macro_rules! impl_encode {
    ($($t:ty),*) => {
        $(impl $t {
            pub fn encode_to_vec(&self) -> Vec<u8> {
                let mut buf = Vec::with_capacity(self.encoded_len());
                self.encode(&mut buf).expect(concat!("encode ", stringify!($t)));
                buf
            }
        })*
    };
}

impl_encode!(amux::Envelope, amux::DeviceState, amux::RuntimeInfo);
```

- [ ] **Step 7: Register the module in `src-tauri/src/lib.rs`**

Find the top-level module declarations (probably near `pub mod commands;`), add:
```rust
pub mod proto;
```

- [ ] **Step 8: Verify compile**

Run: `cd /Volumes/openbeta/workspace/teamclaw-v2 && pnpm rust:check`
Expected: clean. If `Envelope`, `DeviceState`, or `RuntimeInfo` are unknown, open `proto/amux.proto` and adjust the `impl_encode!` list to match the actually-defined messages.

- [ ] **Step 9: Commit**

```bash
git add proto/amux.proto src-tauri/build.rs src-tauri/src/proto.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(proto): vendor amux.proto and wire prost build"
```

---

### Task 0.3: Frontend Protobuf TS bindings

**Files:**
- Modify: `packages/app/package.json` (add `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`)
- Create: `buf.gen.yaml`
- Create: `packages/app/src/lib/proto/index.ts` (generated)
- Modify: `packages/app/package.json` `scripts.proto-gen`

- [ ] **Step 1: Add deps**

```bash
pnpm --filter @teamclaw/app add @bufbuild/protobuf
pnpm --filter @teamclaw/app add -D @bufbuild/protoc-gen-es
```

- [ ] **Step 2: Create `buf.gen.yaml` at repo root**

```yaml
version: v2
plugins:
  - local: ./node_modules/.bin/protoc-gen-es
    out: packages/app/src/lib/proto
    opt:
      - target=ts
      - import_extension=.js
```

- [ ] **Step 3: Add gen script in `packages/app/package.json`**

In `"scripts"`:
```json
"proto-gen": "protoc-gen-es --es_opt=target=ts,import_extension=.js --es_out=src/lib/proto -I ../../proto ../../proto/amux.proto"
```
(Or invoke via `buf generate` if the project adopts buf CLI — pick one, document in README.)

- [ ] **Step 4: Run generation**

```bash
cd packages/app && pnpm proto-gen
```
Expected: `src/lib/proto/amux_pb.ts` created.

- [ ] **Step 5: Add generated file to gitignore exception or commit it**

Per project convention (check `.gitignore` for existing generated files): commit the generated TS so contributors don't need to regenerate. Add to `.gitignore` rationale comment if needed.

```bash
git add packages/app/src/lib/proto/amux_pb.ts
```

- [ ] **Step 6: Smoke import**

Create a throwaway TS file `packages/app/src/lib/proto/__check.ts`:
```ts
import { EnvelopeSchema } from "./amux_pb.js";
console.log(Object.keys(EnvelopeSchema));
```
Run: `pnpm typecheck`
Expected: clean. Then delete `__check.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/app/package.json packages/app/pnpm-lock.yaml buf.gen.yaml packages/app/src/lib/proto
git commit -m "feat(proto): add frontend protobuf bindings"
```

---

### Task 0.4: Add Rust deps for MQTT and Supabase

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add deps**

In `[dependencies]`, mirroring amuxd's versions:
```toml
rumqttc = "0.24"
rustls = "0.22"
tokio-rustls = "0.25"
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
jsonwebtoken = "9"
url = "2"
```
(If any already exist with different versions, take the higher; verify the project still compiles end of step.)

- [ ] **Step 2: Verify compile**

Run: `cd /Volumes/openbeta/workspace/teamclaw-v2 && pnpm rust:check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(deps): add rumqttc, jsonwebtoken, reqwest TLS"
```

---

### Task 0.5: Skeleton `mqtt_bus.rs`

**Files:**
- Create: `src-tauri/src/commands/mqtt_bus.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Read existing commands/mod.rs**

Run: `cat src-tauri/src/commands/mod.rs`
Note current module declarations.

- [ ] **Step 2: Create `mqtt_bus.rs` with stubs that compile and return `not_implemented`**

```rust
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct MqttStatus {
    pub connected: bool,
    pub subscribed_sessions: Vec<String>,
}

#[tauri::command]
pub async fn mqtt_subscribe(_app: AppHandle, _session_id: String) -> Result<(), String> {
    Err("not_implemented".into())
}

#[tauri::command]
pub async fn mqtt_publish(
    _app: AppHandle,
    _session_id: String,
    _envelope_bytes: Vec<u8>,
) -> Result<(), String> {
    Err("not_implemented".into())
}

#[tauri::command]
pub async fn mqtt_status(_app: AppHandle) -> Result<MqttStatus, String> {
    Ok(MqttStatus { connected: false, subscribed_sessions: vec![] })
}
```

- [ ] **Step 3: Add `pub mod mqtt_bus;` in `commands/mod.rs`**

- [ ] **Step 4: Register handlers in `lib.rs`**

Find the existing `tauri::generate_handler![...]` invocation, add:
```rust
commands::mqtt_bus::mqtt_subscribe,
commands::mqtt_bus::mqtt_publish,
commands::mqtt_bus::mqtt_status,
```

- [ ] **Step 5: Verify compile**

Run: `pnpm rust:check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/mqtt_bus.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(mqtt): scaffold mqtt_bus Tauri command surface"
```

---

### Task 0.6: Skeleton `supabase_auth_bridge.rs`

**Files:**
- Create: `src-tauri/src/commands/supabase_auth_bridge.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create stub commands**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SupabaseSession {
    pub user_id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

#[tauri::command]
pub async fn supabase_get_session() -> Result<Option<SupabaseSession>, String> {
    Ok(None)
}

#[tauri::command]
pub async fn supabase_login() -> Result<String, String> {
    Err("not_implemented".into())
}

#[tauri::command]
pub async fn supabase_logout() -> Result<(), String> {
    Err("not_implemented".into())
}

#[tauri::command]
pub async fn supabase_handle_deeplink(_url: String) -> Result<(), String> {
    Err("not_implemented".into())
}
```

- [ ] **Step 2: Register module + handlers (same pattern as 0.5)**

- [ ] **Step 3: Verify and commit**

```bash
pnpm rust:check
git add src-tauri/src/commands/supabase_auth_bridge.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(auth): scaffold supabase_auth_bridge Tauri commands"
```

---

### Task 0.7: Skeleton `daemon_installer.rs`

**Files:**
- Create: `src-tauri/src/commands/daemon_installer.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Stub commands (Phase 2 will fill in)**

```rust
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct DaemonInstallStatus {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn install_local_daemon(_supabase_jwt: String) -> Result<DaemonInstallStatus, String> {
    Err("not_implemented".into())
}

#[tauri::command]
pub async fn daemon_status() -> Result<DaemonInstallStatus, String> {
    Ok(DaemonInstallStatus { installed: false, running: false, version: None })
}

#[tauri::command]
pub async fn uninstall_local_daemon() -> Result<(), String> {
    Err("not_implemented".into())
}
```

- [ ] **Step 2: Register, verify, commit**

```bash
pnpm rust:check
git add src-tauri/src/commands/daemon_installer.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(daemon): scaffold daemon_installer Tauri commands"
```

---

### Task 0.8: Add Supabase JS dep on frontend

**Files:**
- Modify: `packages/app/package.json`

- [ ] **Step 1: Install dep**

```bash
pnpm --filter @teamclaw/app add @supabase/supabase-js
```

- [ ] **Step 2: Verify build**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/app/package.json packages/app/pnpm-lock.yaml
git commit -m "chore(deps): add @supabase/supabase-js"
```

---

### Task 0.9: Define `Actor` and `ActorEvent` types

**Files:**
- Create: `packages/app/src/lib/actor/types.ts`
- Test: `packages/app/src/lib/actor/types.test.ts`

- [ ] **Step 1: Write failing type-level test**

`packages/app/src/lib/actor/types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { Actor, ActorEvent } from "./types";

describe("Actor type", () => {
  it("accepts human and agent variants", () => {
    const human: Actor = {
      actorId: "u1",
      actorType: "human",
      displayName: "张三",
    };
    const agent: Actor = {
      actorId: "agent_xxx",
      actorType: "agent",
      displayName: "Claude",
      deviceId: "device_abc",
    };
    expect(human.actorType).toBe("human");
    expect(agent.deviceId).toBe("device_abc");
  });

  it("ChatMessage event carries actorId, text, mentions", () => {
    const ev: ActorEvent = {
      kind: "chat_message",
      actorId: "u1",
      timestampMs: 1000,
      text: "hi",
      mentionActorIds: ["agent_xxx"],
    };
    expect(ev.kind).toBe("chat_message");
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `pnpm --filter @teamclaw/app test:unit -- types.test`
Expected: FAIL — "Cannot find module './types'".

- [ ] **Step 3: Implement `types.ts`**

```ts
export type ActorType = "human" | "agent";

export interface Actor {
  actorId: string;
  actorType: ActorType;
  displayName: string;
  avatarUrl?: string;
  deviceId?: string;
}

export type ActorEvent =
  | { kind: "chat_message"; actorId: string; timestampMs: number; text: string; mentionActorIds: string[] }
  | { kind: "actor_join"; actor: Actor; timestampMs: number }
  | { kind: "actor_leave"; actorId: string; timestampMs: number }
  | { kind: "agent_invoke"; actorId: string; targetDaemonId: string; workspacePath?: string; timestampMs: number }
  | { kind: "acp_thinking"; actorId: string; text: string; timestampMs: number }
  | { kind: "acp_output_delta"; actorId: string; delta: string; timestampMs: number }
  | { kind: "acp_tool_use"; actorId: string; toolName: string; params: unknown; toolUseId: string; timestampMs: number }
  | { kind: "acp_tool_result"; actorId: string; toolUseId: string; result: unknown; timestampMs: number }
  | { kind: "acp_permission_request"; actorId: string; requestId: string; tool: string; params: unknown; ttlSeconds: number; timestampMs: number }
  | { kind: "acp_permission_grant"; requestId: string; grantedBy: string; timestampMs: number }
  | { kind: "acp_permission_deny"; requestId: string; deniedBy: string; timestampMs: number }
  | { kind: "acp_error"; actorId: string; code: string; message: string; timestampMs: number };
```

- [ ] **Step 4: Run test and confirm pass**

Run: `pnpm --filter @teamclaw/app test:unit -- types.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/actor/types.ts packages/app/src/lib/actor/types.test.ts
git commit -m "feat(actor): define Actor and ActorEvent types"
```

---

### Task 0.10: Implement envelope ↔ ActorEvent mapper

**Files:**
- Create: `packages/app/src/lib/actor/event-mapper.ts`
- Test: `packages/app/src/lib/actor/event-mapper.test.ts`
- Create: `tests/fixtures/envelopes/chat-message.json`

- [ ] **Step 1: Capture an envelope fixture**

Create `tests/fixtures/envelopes/chat-message.json`:
```json
{
  "id": "env_001",
  "timestamp": 1715000000.0,
  "payload": {
    "case": "chatMessage",
    "value": {
      "actorId": "u_zhangsan",
      "text": "hello",
      "mentionActorIds": ["agent_claude"]
    }
  }
}
```

(This represents the JSON shape that `mqtt_bus.rs` will emit after Rust-side prost decode + serde_json. The exact shape depends on how prost-generated structs serde-serialize; verify with the actual decode in Phase 1B and update if needed.)

- [ ] **Step 2: Write failing mapper test**

`packages/app/src/lib/actor/event-mapper.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { envelopeJsonToActorEvent } from "./event-mapper";
import fixture from "../../../../../tests/fixtures/envelopes/chat-message.json";

describe("envelopeJsonToActorEvent", () => {
  it("maps a chat_message envelope", () => {
    const ev = envelopeJsonToActorEvent(fixture);
    expect(ev).toEqual({
      kind: "chat_message",
      actorId: "u_zhangsan",
      timestampMs: 1715000000000,
      text: "hello",
      mentionActorIds: ["agent_claude"],
    });
  });

  it("returns null for unknown payload case", () => {
    const ev = envelopeJsonToActorEvent({
      id: "x",
      timestamp: 1,
      payload: { case: "totallyUnknown", value: {} },
    });
    expect(ev).toBeNull();
  });
});
```

- [ ] **Step 3: Run test and confirm failure**

Run: `pnpm --filter @teamclaw/app test:unit -- event-mapper`
Expected: FAIL.

- [ ] **Step 4: Implement mapper**

`packages/app/src/lib/actor/event-mapper.ts`:
```ts
import type { ActorEvent } from "./types";

export interface EnvelopeJson {
  id: string;
  timestamp: number;
  payload: { case: string; value: Record<string, unknown> };
}

export function envelopeJsonToActorEvent(env: EnvelopeJson): ActorEvent | null {
  const ts = Math.round(env.timestamp * 1000);
  switch (env.payload.case) {
    case "chatMessage": {
      const v = env.payload.value as { actorId: string; text: string; mentionActorIds?: string[] };
      return {
        kind: "chat_message",
        actorId: v.actorId,
        timestampMs: ts,
        text: v.text,
        mentionActorIds: v.mentionActorIds ?? [],
      };
    }
    case "actorJoin": {
      const v = env.payload.value as { actor: { actorId: string; actorType: "human" | "agent"; displayName: string; avatarUrl?: string; deviceId?: string } };
      return { kind: "actor_join", actor: v.actor, timestampMs: ts };
    }
    case "actorLeave": {
      const v = env.payload.value as { actorId: string };
      return { kind: "actor_leave", actorId: v.actorId, timestampMs: ts };
    }
    default:
      return null;
  }
}

export function actorEventToEnvelopeJson(ev: ActorEvent): EnvelopeJson {
  const id = crypto.randomUUID();
  const timestamp = ev.timestampMs / 1000;
  switch (ev.kind) {
    case "chat_message":
      return {
        id,
        timestamp,
        payload: {
          case: "chatMessage",
          value: { actorId: ev.actorId, text: ev.text, mentionActorIds: ev.mentionActorIds },
        },
      };
    default:
      throw new Error(`actorEventToEnvelopeJson: cannot serialize kind=${ev.kind} (out of scope for Phase 1)`);
  }
}
```

- [ ] **Step 5: Run test and confirm pass**

Run: `pnpm --filter @teamclaw/app test:unit -- event-mapper`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/lib/actor packages/app/tests/fixtures/envelopes/chat-message.json
git commit -m "feat(actor): envelope <-> ActorEvent mapper with fixture-driven tests"
```

(Adjust path: fixtures may live at `tests/fixtures/` at repo root rather than under `packages/app/`. Pick one location and stick to it.)

---

### Task 0.11: Phase 0 smoke

- [ ] **Step 1: Run full local pipeline**

```bash
cd /Volumes/openbeta/workspace/teamclaw-v2
pnpm rust:check
pnpm typecheck
pnpm lint
pnpm test:unit
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```
Expected: all green. App still uses opencode (unchanged); skeletons exist but are unused.

- [ ] **Step 2: Boot dev server**

```bash
pnpm tauri:dev
```
Expected: app boots, OpenCode session works as in v1.

- [ ] **Step 3: Tag Phase 0 done in commit message**

```bash
git commit --allow-empty -m "chore: phase 0 complete (scaffold, no behavior change)"
```

---

## Phase 1A — Supabase Auth

### Task 1A.1: Tauri deeplink registration

**Files:**
- Modify: `tauri.conf.json`
- Modify: `src-tauri/Cargo.toml` (add `tauri-plugin-deep-link`)
- Modify: `src-tauri/src/lib.rs` (init plugin)

- [ ] **Step 1: Add deeplink plugin dependency**

```bash
cd src-tauri && cargo add tauri-plugin-deep-link
```

- [ ] **Step 2: Add deeplink config to `tauri.conf.json`**

Locate the `plugins` block (or create one), add:
```json
"deep-link": {
  "mobile": [],
  "desktop": {
    "schemes": ["teamclaw"]
  }
}
```

- [ ] **Step 3: Initialize the plugin in `lib.rs`**

In the Tauri builder chain, add:
```rust
.plugin(tauri_plugin_deep_link::init())
```

- [ ] **Step 4: Wire the deeplink handler**

In the builder's `.setup(|app| { ... })`:
```rust
use tauri_plugin_deep_link::DeepLinkExt;
app.deep_link().on_open_url(|event| {
    let urls: Vec<_> = event.urls().iter().map(|u| u.to_string()).collect();
    if let Some(url) = urls.into_iter().next() {
        tracing::info!("deeplink received: {url}");
    }
});
```

- [ ] **Step 5: Smoke test deeplink registration**

Run on macOS:
```bash
open "teamclaw://test?foo=bar"
```
Expected: app receives the deeplink (visible in tracing logs); if app is not running, it launches.

- [ ] **Step 6: Commit**

```bash
git add tauri.conf.json src-tauri/Cargo.toml src-tauri/src/lib.rs
git commit -m "feat(auth): register teamclaw:// deeplink scheme"
```

---

### Task 1A.2: Supabase OAuth state machine + token refresh

**Files:**
- Create: `src-tauri/src/supabase_auth/mod.rs`
- Create: `src-tauri/src/supabase_auth/client.rs`
- Create: `src-tauri/src/supabase_auth/store.rs`
- Modify: `src-tauri/src/commands/supabase_auth_bridge.rs`
- Test: `src-tauri/src/supabase_auth/store_tests.rs`

- [ ] **Step 1: Add module declarations in `lib.rs`**

```rust
pub mod supabase_auth;
```

- [ ] **Step 2: Define `SupabaseSession` and store in `store.rs`**

```rust
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupabaseSession {
    pub user_id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
}

pub fn auth_path() -> PathBuf {
    dirs::home_dir().expect("home dir").join(".teamclaw/auth.json")
}

pub fn load() -> anyhow::Result<Option<SupabaseSession>> {
    let path = auth_path();
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}

pub fn save(session: &SupabaseSession) -> anyhow::Result<()> {
    let path = auth_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec(session)?;
    std::fs::write(&path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn clear() -> anyhow::Result<()> {
    let path = auth_path();
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}
```

- [ ] **Step 3: Write store unit tests**

Create `src-tauri/src/supabase_auth/store_tests.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::super::store::*;
    use tempfile::TempDir;

    fn with_home_override<F: FnOnce()>(f: F) {
        let tmp = TempDir::new().unwrap();
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", tmp.path());
        f();
        if let Some(p) = prev { std::env::set_var("HOME", p); } else { std::env::remove_var("HOME"); }
    }

    #[test]
    fn round_trip_session() {
        with_home_override(|| {
            let s = SupabaseSession {
                user_id: "u1".into(),
                access_token: "at".into(),
                refresh_token: "rt".into(),
                expires_at: 12345,
            };
            save(&s).unwrap();
            let loaded = load().unwrap().unwrap();
            assert_eq!(loaded.user_id, "u1");
            assert_eq!(loaded.access_token, "at");
        });
    }

    #[test]
    fn load_returns_none_when_missing() {
        with_home_override(|| {
            assert!(load().unwrap().is_none());
        });
    }

    #[test]
    fn clear_removes_file() {
        with_home_override(|| {
            let s = SupabaseSession {
                user_id: "u".into(),
                access_token: "a".into(),
                refresh_token: "r".into(),
                expires_at: 0,
            };
            save(&s).unwrap();
            assert!(load().unwrap().is_some());
            clear().unwrap();
            assert!(load().unwrap().is_none());
        });
    }
}
```

- [ ] **Step 4: Add `tempfile` to `[dev-dependencies]` in `src-tauri/Cargo.toml`**

```toml
tempfile = "3"
```

- [ ] **Step 5: Wire `store_tests.rs` from `mod.rs`**

`src-tauri/src/supabase_auth/mod.rs`:
```rust
pub mod client;
pub mod store;

#[cfg(test)]
mod store_tests;
```

- [ ] **Step 6: Run tests and confirm pass**

```bash
cargo test --manifest-path src-tauri/Cargo.toml supabase_auth
```
Expected: 3 tests pass.

- [ ] **Step 7: Implement `client.rs` — refresh token call**

```rust
use serde::{Deserialize, Serialize};

const SUPABASE_URL: &str = env!("TEAMCLAW_SUPABASE_URL");
const SUPABASE_ANON_KEY: &str = env!("TEAMCLAW_SUPABASE_ANON_KEY");

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub user: User,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct User {
    pub id: String,
}

pub async fn refresh(refresh_token: &str) -> anyhow::Result<TokenResponse> {
    let url = format!("{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token");
    let body = serde_json::json!({ "refresh_token": refresh_token });
    let resp = reqwest::Client::new()
        .post(url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("supabase refresh failed: {}", resp.status());
    }
    Ok(resp.json::<TokenResponse>().await?)
}
```

- [ ] **Step 8: Set build-time env vars**

Document in worktree's `README.md` or a new `docs/dev-env.md`:
```bash
export TEAMCLAW_SUPABASE_URL="https://<project>.supabase.co"
export TEAMCLAW_SUPABASE_ANON_KEY="<anon-key>"
```
Or add to `src-tauri/build.rs` a fallback to read from `.env.dev`. Pick one; document.

- [ ] **Step 9: Update `commands/supabase_auth_bridge.rs` to call store**

Replace `supabase_get_session` body:
```rust
#[tauri::command]
pub async fn supabase_get_session() -> Result<Option<crate::supabase_auth::store::SupabaseSession>, String> {
    crate::supabase_auth::store::load().map_err(|e| e.to_string())
}
```

- [ ] **Step 10: Verify and commit**

```bash
pnpm rust:check
cargo test --manifest-path src-tauri/Cargo.toml supabase_auth
git add src-tauri
git commit -m "feat(auth): supabase_auth module with persistent session store"
```

---

### Task 1A.3: OAuth login deeplink flow (Tauri side)

**Files:**
- Modify: `src-tauri/src/commands/supabase_auth_bridge.rs`
- Modify: `src-tauri/src/lib.rs` (deeplink handler dispatches to bridge)

- [ ] **Step 1: Implement `supabase_login` to open browser**

Replace stub:
```rust
#[tauri::command]
pub async fn supabase_login(app: tauri::AppHandle) -> Result<(), String> {
    let url = format!(
        "{}/auth/v1/authorize?provider=github&redirect_to=teamclaw://auth-callback",
        env!("TEAMCLAW_SUPABASE_URL")
    );
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(&url, None::<String>)
        .map_err(|e| e.to_string())?;
    Ok(())
}
```
(Provider `github` is one example; substitute the actual provider in use. Add `tauri-plugin-opener` if not already present.)

- [ ] **Step 2: Implement `supabase_handle_deeplink`**

```rust
#[tauri::command]
pub async fn supabase_handle_deeplink(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "teamclaw" || parsed.host_str() != Some("auth-callback") {
        return Err("not an auth deeplink".into());
    }
    let fragment = parsed.fragment().ok_or("missing fragment")?;
    let pairs: std::collections::HashMap<String, String> = url::form_urlencoded::parse(fragment.as_bytes())
        .into_owned()
        .collect();
    let access_token = pairs.get("access_token").ok_or("missing access_token")?.clone();
    let refresh_token = pairs.get("refresh_token").ok_or("missing refresh_token")?.clone();
    let expires_in: i64 = pairs.get("expires_in").and_then(|s| s.parse().ok()).unwrap_or(3600);

    // Decode JWT to get user_id (sub claim)
    use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
    let mut validation = Validation::new(Algorithm::HS256);
    validation.insecure_disable_signature_validation();
    let token_data: jsonwebtoken::TokenData<serde_json::Value> = decode(
        &access_token,
        &DecodingKey::from_secret(b""),
        &validation,
    ).map_err(|e| e.to_string())?;
    let user_id = token_data.claims.get("sub").and_then(|v| v.as_str()).ok_or("missing sub")?.to_string();

    let session = crate::supabase_auth::store::SupabaseSession {
        user_id,
        access_token,
        refresh_token,
        expires_at: chrono::Utc::now().timestamp() + expires_in,
    };
    crate::supabase_auth::store::save(&session).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 3: Connect the deeplink plugin handler to this command**

In `lib.rs` setup, replace the placeholder logging with:
```rust
let app_handle = app.handle().clone();
app.deep_link().on_open_url(move |event| {
    if let Some(url) = event.urls().iter().next().map(|u| u.to_string()) {
        let h = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::commands::supabase_auth_bridge::supabase_handle_deeplink(url).await {
                tracing::warn!("deeplink handle error: {e}");
            }
            let _ = h.emit("auth:state-changed", ());
        });
    }
});
```

- [ ] **Step 4: Implement `supabase_logout`**

```rust
#[tauri::command]
pub async fn supabase_logout() -> Result<(), String> {
    crate::supabase_auth::store::clear().map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Verify build**

```bash
pnpm rust:check
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri
git commit -m "feat(auth): OAuth deeplink flow end-to-end (Tauri side)"
```

---

### Task 1A.4: Frontend Supabase client

**Files:**
- Create: `packages/app/src/lib/supabase-client.ts`
- Test: `packages/app/src/lib/supabase-client.test.ts`

- [ ] **Step 1: Create env types**

`packages/app/src/lib/supabase-client.ts`:
```ts
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing");
}

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface SessionRow {
  id: string;
  title: string;
  created_by_actor_id: string;
  created_at: string;
  updated_at: string;
}

export async function listSessionsForUser(userId: string): Promise<SessionRow[]> {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, title, created_by_actor_id, created_at, updated_at")
    .eq("created_by_actor_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}
```

- [ ] **Step 2: Add Vite env types**

In `packages/app/src/vite-env.d.ts` (create if missing):
```ts
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 3: Write a unit test stubbing `supabase`**

`packages/app/src/lib/supabase-client.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: async () => ({ data: [{ id: "s1", title: "t", created_by_actor_id: "u1", created_at: "2026-05-08", updated_at: "2026-05-08" }], error: null }),
        }),
      }),
    }),
  }),
}));

import("./supabase-client").then(async (mod) => {
  describe("listSessionsForUser", () => {
    it("returns rows", async () => {
      const rows = await mod.listSessionsForUser("u1");
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe("s1");
    });
  });
});
```

- [ ] **Step 4: Set Vite env vars for dev**

Create `packages/app/.env.development`:
```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

Add `.env.development` to `.gitignore` if not already.

- [ ] **Step 5: Run typecheck + test**

```bash
pnpm typecheck
pnpm --filter @teamclaw/app test:unit -- supabase-client
```
Expected: clean / pass.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/lib/supabase-client.ts packages/app/src/lib/supabase-client.test.ts packages/app/src/vite-env.d.ts packages/app/.env.development packages/app/.gitignore
git commit -m "feat(supabase): frontend client + listSessionsForUser query"
```

---

### Task 1A.5: Frontend auth store + login screen

**Files:**
- Create: `packages/app/src/stores/auth-store.ts`
- Create: `packages/app/src/components/auth/LoginScreen.tsx`
- Modify: app root component (likely `packages/app/src/App.tsx`) to gate on auth state

- [ ] **Step 1: Write auth store**

```ts
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface SupabaseSession {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface AuthState {
  session: SupabaseSession | null;
  loading: boolean;
  hydrate: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  loading: true,
  hydrate: async () => {
    set({ loading: true });
    const session = (await invoke<SupabaseSession | null>("supabase_get_session"));
    set({ session, loading: false });
  },
  login: async () => {
    await invoke("supabase_login");
  },
  logout: async () => {
    await invoke("supabase_logout");
    set({ session: null });
  },
}));

let unlisten: (() => void) | null = null;
export async function startAuthListener() {
  if (unlisten) return;
  const fn = await listen("auth:state-changed", () => {
    useAuthStore.getState().hydrate();
  });
  unlisten = fn;
}
```

- [ ] **Step 2: Build login screen**

`packages/app/src/components/auth/LoginScreen.tsx`:
```tsx
import { useAuthStore } from "@/stores/auth-store";

export function LoginScreen() {
  const login = useAuthStore((s) => s.login);
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="rounded border p-6 text-center">
        <h1 className="mb-4 text-lg">Sign in to TeamClaw</h1>
        <button onClick={() => login()} className="rounded bg-blue-600 px-4 py-2 text-white">
          Continue with Provider
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Gate the app on auth**

In app root (verify path; likely `packages/app/src/App.tsx`):
```tsx
import { useEffect } from "react";
import { useAuthStore, startAuthListener } from "@/stores/auth-store";
import { LoginScreen } from "@/components/auth/LoginScreen";

export function App() {
  const { session, loading, hydrate } = useAuthStore();

  useEffect(() => {
    hydrate();
    startAuthListener();
  }, [hydrate]);

  if (loading) return <div className="p-8">Loading...</div>;
  if (!session) return <LoginScreen />;
  return <ExistingAppContent />; // current app shell
}
```

- [ ] **Step 4: Manual smoke test**

```bash
pnpm tauri:dev
```
Expected: app shows login screen → click Continue → browser opens Supabase auth → after consent, deeplink fires → app shows ExistingAppContent.

- [ ] **Step 5: Commit**

```bash
git add packages/app
git commit -m "feat(auth): login screen and auth gating"
```

---

## Phase 1B — MQTT Bus

### Task 1B.1: Implement `mqtt/client.rs` (rumqttc connect + TLS)

**Files:**
- Create: `src-tauri/src/mqtt/mod.rs`
- Create: `src-tauri/src/mqtt/client.rs`
- Create: `src-tauri/src/mqtt/topics.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod mqtt;`)

- [ ] **Step 1: Reference amuxd's client**

Read: `/Volumes/openbeta/workspace/amux/daemon/src/mqtt/client.rs`. Note its `Client` struct, `connect()`, and `event_loop` polling structure. Mirror it.

- [ ] **Step 2: Create `topics.rs`**

```rust
pub fn session_topic(session_id: &str) -> String {
    format!("session/{session_id}/live")
}

pub fn device_state_topic(device_id: &str) -> String {
    format!("device/{device_id}/state")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_topic_format() {
        assert_eq!(session_topic("s1"), "session/s1/live");
    }
}
```

- [ ] **Step 3: Create `client.rs`**

```rust
use anyhow::Result;
use rumqttc::{AsyncClient, EventLoop, MqttOptions, Transport, QoS};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct MqttClient {
    pub client: AsyncClient,
    pub event_loop: Arc<Mutex<EventLoop>>,
    pub client_id: String,
}

pub struct ClientConfig {
    pub broker_host: String,
    pub broker_port: u16,
    pub client_id: String,
    pub username: String,
    pub password: String,
}

impl MqttClient {
    pub fn connect(cfg: ClientConfig) -> Result<Self> {
        let mut opts = MqttOptions::new(&cfg.client_id, &cfg.broker_host, cfg.broker_port);
        opts.set_credentials(&cfg.username, &cfg.password);
        opts.set_clean_session(false);
        opts.set_keep_alive(std::time::Duration::from_secs(30));
        opts.set_transport(Transport::tls_with_default_config());
        let (client, event_loop) = AsyncClient::new(opts, 64);
        Ok(MqttClient {
            client,
            event_loop: Arc::new(Mutex::new(event_loop)),
            client_id: cfg.client_id,
        })
    }
}
```

- [ ] **Step 4: `mod.rs` exports**

```rust
pub mod client;
pub mod topics;

pub use client::{ClientConfig, MqttClient};
```

- [ ] **Step 5: Add `pub mod mqtt;` to `lib.rs`**

- [ ] **Step 6: Run topics test**

```bash
cargo test --manifest-path src-tauri/Cargo.toml topics
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri
git commit -m "feat(mqtt): core client with TLS connect (no event loop yet)"
```

---

### Task 1B.2: Event loop, subscribe, publish

**Files:**
- Modify: `src-tauri/src/mqtt/client.rs`
- Modify: `src-tauri/src/commands/mqtt_bus.rs`
- Modify: `src-tauri/src/lib.rs` (manage state)

- [ ] **Step 1: Add `MqttBus` shared-state type**

In `src-tauri/src/mqtt/mod.rs` (extend):
```rust
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct MqttBus {
    pub client: Arc<Mutex<Option<MqttClient>>>,
    pub subscribed: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl MqttBus {
    pub fn new() -> Self {
        Self {
            client: Arc::new(Mutex::new(None)),
            subscribed: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }
}
```

- [ ] **Step 2: Add the bus to Tauri state in `lib.rs`**

```rust
.manage(crate::mqtt::MqttBus::new())
```
(Inside the builder chain, before `.run`.)

- [ ] **Step 3: Implement `mqtt_subscribe` to actually subscribe**

```rust
use crate::mqtt::{MqttBus, topics};
use rumqttc::QoS;
use tauri::State;

#[tauri::command]
pub async fn mqtt_subscribe(
    bus: State<'_, MqttBus>,
    session_id: String,
) -> Result<(), String> {
    let topic = topics::session_topic(&session_id);
    let client_guard = bus.client.lock().await;
    let client = client_guard.as_ref().ok_or("mqtt not connected")?;
    client.client.subscribe(topic, QoS::AtLeastOnce).await.map_err(|e| e.to_string())?;
    bus.subscribed.lock().await.insert(session_id);
    Ok(())
}
```

- [ ] **Step 4: Implement `mqtt_publish`**

```rust
#[tauri::command]
pub async fn mqtt_publish(
    bus: State<'_, MqttBus>,
    session_id: String,
    envelope_bytes: Vec<u8>,
) -> Result<(), String> {
    let topic = topics::session_topic(&session_id);
    let client_guard = bus.client.lock().await;
    let client = client_guard.as_ref().ok_or("mqtt not connected")?;
    client.client.publish(topic, QoS::AtLeastOnce, false, envelope_bytes).await.map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 5: Implement event loop driver**

In `src-tauri/src/mqtt/client.rs`, add:
```rust
pub async fn run_event_loop(
    bus: Arc<MqttBus>,
    app: tauri::AppHandle,
) {
    use rumqttc::{Event, Packet};
    use prost::Message;
    use crate::proto::amux::Envelope;

    loop {
        let event_loop_arc = {
            let guard = bus.client.lock().await;
            guard.as_ref().map(|c| c.event_loop.clone())
        };
        let Some(event_loop) = event_loop_arc else {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            continue;
        };
        let mut event_loop = event_loop.lock().await;
        match event_loop.poll().await {
            Ok(Event::Incoming(Packet::Publish(p))) => {
                let topic = p.topic.clone();
                match Envelope::decode(p.payload.as_ref()) {
                    Ok(env) => {
                        let json = serde_json::to_value(&env).unwrap_or(serde_json::Value::Null);
                        let payload = serde_json::json!({ "topic": topic, "envelope": json });
                        let _ = app.emit("mqtt:envelope", payload);
                    }
                    Err(e) => tracing::warn!("envelope decode error: {e}"),
                }
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("mqtt event loop error: {e}, reconnecting in 1s");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
}
```
(Note: `Envelope` JSON shape requires `serde` feature on prost-build. If prost-generated types don't derive serde, add a serde_derive shim or convert manually with a hand-written struct that mirrors `Envelope` for serialization.)

- [ ] **Step 6: Spawn event loop on bus connect**

Add a `mqtt_connect` command (called from frontend after Supabase auth):
```rust
#[tauri::command]
pub async fn mqtt_connect(
    app: tauri::AppHandle,
    bus: State<'_, MqttBus>,
    broker_host: String,
    broker_port: u16,
    username: String,
    password: String,
    client_id: String,
) -> Result<(), String> {
    let cfg = crate::mqtt::ClientConfig { broker_host, broker_port, client_id, username, password };
    let client = crate::mqtt::MqttClient::connect(cfg).map_err(|e| e.to_string())?;
    *bus.client.lock().await = Some(client);

    let bus_arc: Arc<MqttBus> = Arc::new(/* clone the inner state */ unimplemented!());
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::mqtt::client::run_event_loop(bus_arc, app_clone).await;
    });
    Ok(())
}
```
(Adjust `bus_arc` cloning. `MqttBus` should ideally be `Arc<MqttBusInner>` so that `State<'_, MqttBus>` can be cloned by reference. Refactor `MqttBus` definition if needed.)

- [ ] **Step 7: Register `mqtt_connect` handler in `lib.rs`**

- [ ] **Step 8: Compile-check**

```bash
pnpm rust:check
```
Expected: clean. Resolve `unimplemented!()` and any borrow issues.

- [ ] **Step 9: Commit**

```bash
git add src-tauri
git commit -m "feat(mqtt): subscribe/publish/event-loop end-to-end"
```

---

### Task 1B.3: Reconnect with exponential backoff

**Files:**
- Modify: `src-tauri/src/mqtt/client.rs`

- [ ] **Step 1: Add backoff state**

In `run_event_loop`, replace the `Err(e) => sleep(1s)` arm with:
```rust
Err(e) => {
    use std::sync::atomic::{AtomicU64, Ordering};
    static BACKOFF: AtomicU64 = AtomicU64::new(1);
    let cur = BACKOFF.fetch_min(60, Ordering::Relaxed).max(1);
    tracing::warn!("mqtt error: {e}, retry in {cur}s");
    tokio::time::sleep(std::time::Duration::from_secs(cur)).await;
    let next = (cur * 2).min(60);
    BACKOFF.store(next, Ordering::Relaxed);
}
Ok(_) => {
    use std::sync::atomic::{AtomicU64, Ordering};
    static BACKOFF: AtomicU64 = AtomicU64::new(1);
    BACKOFF.store(1, Ordering::Relaxed);
}
```

- [ ] **Step 2: Verify compile**

```bash
pnpm rust:check
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(mqtt): exponential backoff reconnect"
```

---

### Task 1B.4: Retained message handling

Already covered: rumqttc emits retained messages on subscribe automatically. No code change needed beyond verifying behavior.

- [ ] **Step 1: Manual smoke test against EMQX dev broker**

Connect a separate `mosquitto_pub -h <emqx-host> -t session/test/live -r -m "<retained payload>"`. Subscribe via the app and confirm UI receives the retained message on first subscribe.

- [ ] **Step 2: Document in `docs/dev-mqtt.md`** (create file)

```markdown
# MQTT dev setup

Use EMQX dev broker (or local mosquitto) with TLS:
- host: <env value>
- port: 8883
- credentials: Supabase JWT as username, "" as password

To test retained:
mosquitto_pub -h <host> -t session/<id>/live -r -m '<envelope-bytes>'
```

- [ ] **Step 3: Commit**

```bash
git add docs/dev-mqtt.md
git commit -m "docs: mqtt dev setup notes"
```

---

### Task 1B.5: LWT publish on disconnect

**Files:**
- Modify: `src-tauri/src/mqtt/client.rs`

- [ ] **Step 1: Set `LastWill` on `MqttOptions`**

In `MqttClient::connect`:
```rust
use rumqttc::LastWill;

let lwt_topic = format!("device/{}/state", &cfg.client_id);
let lwt_payload = serde_json::json!({ "status": "offline" }).to_string().into_bytes();
opts.set_last_will(LastWill::new(lwt_topic, lwt_payload, QoS::AtLeastOnce, true));
```

- [ ] **Step 2: Commit**

```bash
git commit -am "feat(mqtt): set Last Will and Testament on connect"
```

---

### Task 1B.6: macOS sleep/wake force-reconnect

**Files:**
- Modify: `src-tauri/src/mqtt/client.rs` or new `src-tauri/src/mqtt/sleep_hook.rs`

- [ ] **Step 1: Reference existing hook**

Read `src-tauri/src/webview_recovery.rs` (this is what fixes webview recovery after sleep — same OS notification source applies).

- [ ] **Step 2: Add a public `force_reconnect()` on `MqttBus`**

```rust
impl MqttBus {
    pub async fn force_reconnect(&self) {
        if let Some(client) = self.client.lock().await.as_ref() {
            let _ = client.client.disconnect().await;
        }
    }
}
```

- [ ] **Step 3: Wire from existing wake notification (in `webview_recovery.rs` or `lib.rs`)**

Where the wake notification fires, call:
```rust
let bus = app.state::<MqttBus>();
let _ = bus.force_reconnect().await;
```

- [ ] **Step 4: Verify compile + commit**

```bash
pnpm rust:check
git commit -am "feat(mqtt): force reconnect on macOS wake"
```

---

## Phase 1C — Frontend MQTT Bridge

### Task 1C.1: `mqtt-bridge.ts`

**Files:**
- Create: `packages/app/src/lib/mqtt-bridge.ts`

- [ ] **Step 1: Implement bridge**

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { envelopeJsonToActorEvent, type EnvelopeJson } from "@/lib/actor/event-mapper";
import type { ActorEvent } from "@/lib/actor/types";

export interface IncomingEnvelope {
  topic: string;
  envelope: EnvelopeJson;
}

export async function mqttSubscribe(sessionId: string): Promise<void> {
  await invoke("mqtt_subscribe", { sessionId });
}

export async function mqttPublishEnvelope(sessionId: string, envelope: EnvelopeJson): Promise<void> {
  // Re-encode to bytes via Tauri command after sending JSON to Rust;
  // Phase 1: send raw JSON; Rust converts to protobuf and publishes.
  await invoke("mqtt_publish_json", { sessionId, envelope });
}

export async function listenForEnvelopes(handler: (sid: string, ev: ActorEvent) => void): Promise<UnlistenFn> {
  return listen<IncomingEnvelope>("mqtt:envelope", (msg) => {
    const sid = msg.payload.topic.split("/")[1];
    const ev = envelopeJsonToActorEvent(msg.payload.envelope);
    if (ev) handler(sid, ev);
  });
}
```

(Note: this introduces a new `mqtt_publish_json` Tauri command that converts JSON → protobuf in Rust, simpler than encoding in TS for Phase 1. Add it.)

- [ ] **Step 2: Add `mqtt_publish_json` to `mqtt_bus.rs`**

```rust
#[tauri::command]
pub async fn mqtt_publish_json(
    bus: State<'_, MqttBus>,
    session_id: String,
    envelope: serde_json::Value,
) -> Result<(), String> {
    let env: crate::proto::amux::Envelope = serde_json::from_value(envelope).map_err(|e| e.to_string())?;
    let bytes = env.encode_to_vec();
    mqtt_publish(bus, session_id, bytes).await
}
```

(Requires `Envelope` to support `Deserialize`. If prost-build doesn't add serde derives, add `prost-build` `.type_attribute` calls in `build.rs`:)
```rust
prost_build::Config::new()
    .type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]")
    .compile_protos(&[proto], &["../proto"])
```

- [ ] **Step 3: Register handler in `lib.rs`**

- [ ] **Step 4: Compile-check + commit**

```bash
pnpm rust:check
pnpm typecheck
git add src-tauri packages/app/src/lib/mqtt-bridge.ts
git commit -m "feat(mqtt): frontend bridge with JSON publish helper"
```

---

### Task 1C.2: Bridge tests with mocked Tauri

**Files:**
- Create: `packages/app/src/lib/mqtt-bridge.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

const { mqttSubscribe, mqttPublishEnvelope, listenForEnvelopes } = await import("./mqtt-bridge");

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("mqtt-bridge", () => {
  it("mqttSubscribe forwards to Tauri", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await mqttSubscribe("s1");
    expect(invokeMock).toHaveBeenCalledWith("mqtt_subscribe", { sessionId: "s1" });
  });

  it("mqttPublishEnvelope forwards to Tauri", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const env = { id: "e1", timestamp: 1, payload: { case: "chatMessage", value: { actorId: "u", text: "x", mentionActorIds: [] } } };
    await mqttPublishEnvelope("s1", env);
    expect(invokeMock).toHaveBeenCalledWith("mqtt_publish_json", { sessionId: "s1", envelope: env });
  });

  it("listenForEnvelopes maps incoming envelope to ActorEvent", async () => {
    const handlers: Array<(msg: { payload: { topic: string; envelope: unknown } }) => void> = [];
    listenMock.mockImplementation((_event: string, fn: (msg: { payload: { topic: string; envelope: unknown } }) => void) => {
      handlers.push(fn);
      return Promise.resolve(() => {});
    });
    const out: Array<[string, unknown]> = [];
    await listenForEnvelopes((sid, ev) => out.push([sid, ev]));
    handlers[0]({
      payload: {
        topic: "session/s1/live",
        envelope: { id: "e", timestamp: 1, payload: { case: "chatMessage", value: { actorId: "u", text: "x", mentionActorIds: [] } } },
      },
    });
    expect(out[0][0]).toBe("s1");
    expect((out[0][1] as { kind: string }).kind).toBe("chat_message");
  });
});
```

- [ ] **Step 2: Run test**

```bash
pnpm --filter @teamclaw/app test:unit -- mqtt-bridge
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/lib/mqtt-bridge.test.ts
git commit -m "test(mqtt): bridge unit tests with mocked Tauri"
```

---

### Task 1C.3: Session event bus store

**Files:**
- Create: `packages/app/src/stores/session-event-bus.ts`

- [ ] **Step 1: Implement**

```ts
import { create } from "zustand";
import { listenForEnvelopes } from "@/lib/mqtt-bridge";
import type { ActorEvent } from "@/lib/actor/types";

interface BusState {
  perSession: Record<string, ActorEvent[]>;
  start: () => Promise<void>;
}

let started = false;

export const useSessionEventBus = create<BusState>((set, get) => ({
  perSession: {},
  start: async () => {
    if (started) return;
    started = true;
    await listenForEnvelopes((sid, ev) => {
      const cur = get().perSession[sid] ?? [];
      set({ perSession: { ...get().perSession, [sid]: [...cur, ev] } });
    });
  },
}));
```

- [ ] **Step 2: Smoke build**

```bash
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/stores/session-event-bus.ts
git commit -m "feat(stores): session event bus dispatching MQTT envelopes"
```

---

## Phase 1D — ChatPanel on Actor Model

### Task 1D.1: New `session-store.ts`

**Files:**
- Replace contents of: `packages/app/src/stores/session-store.ts`
- Test: `packages/app/src/stores/session-store.test.ts`

- [ ] **Step 1: Read current session-store.ts**

```bash
cat packages/app/src/stores/session-store.ts
```
Note its public API (the parts ChatPanel imports). Keep the same export names where reasonable to minimize ChatPanel churn.

- [ ] **Step 2: Write failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "./session-store";
import type { ActorEvent } from "@/lib/actor/types";

beforeEach(() => {
  useSessionStore.setState({ events: {}, currentSessionId: null });
});

describe("session-store", () => {
  it("appends events", () => {
    const ev: ActorEvent = { kind: "chat_message", actorId: "u", timestampMs: 1, text: "hi", mentionActorIds: [] };
    useSessionStore.getState().pushEvent("s1", ev);
    expect(useSessionStore.getState().events["s1"].length).toBe(1);
  });

  it("returns events for current session", () => {
    const ev: ActorEvent = { kind: "chat_message", actorId: "u", timestampMs: 1, text: "hi", mentionActorIds: [] };
    useSessionStore.setState({ currentSessionId: "s1", events: { s1: [ev] } });
    expect(useSessionStore.getState().currentEvents().length).toBe(1);
  });
});
```

- [ ] **Step 3: Confirm failure**

```bash
pnpm --filter @teamclaw/app test:unit -- session-store
```
Expected: FAIL.

- [ ] **Step 4: Implement (replace existing file contents)**

```ts
import { create } from "zustand";
import type { ActorEvent } from "@/lib/actor/types";

interface SessionState {
  events: Record<string, ActorEvent[]>;
  currentSessionId: string | null;
  setCurrent: (sid: string | null) => void;
  pushEvent: (sid: string, ev: ActorEvent) => void;
  currentEvents: () => ActorEvent[];
}

export const useSessionStore = create<SessionState>((set, get) => ({
  events: {},
  currentSessionId: null,
  setCurrent: (sid) => set({ currentSessionId: sid }),
  pushEvent: (sid, ev) => {
    const cur = get().events[sid] ?? [];
    set({ events: { ...get().events, [sid]: [...cur, ev] } });
  },
  currentEvents: () => {
    const sid = get().currentSessionId;
    return sid ? (get().events[sid] ?? []) : [];
  },
}));
```

- [ ] **Step 5: Confirm pass**

```bash
pnpm --filter @teamclaw/app test:unit -- session-store
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/stores/session-store.ts packages/app/src/stores/session-store.test.ts
git commit -m "feat(stores): rewrite session-store on ActorEvent"
```

---

### Task 1D.2: ChatPanel renders events by actor

**Files:**
- Modify: `packages/app/src/components/chat/ChatPanel.tsx` (or wherever messages render)

- [ ] **Step 1: Read existing ChatPanel**

```bash
ls packages/app/src/components/chat/
```
Identify the message-list component (likely `MessageList.tsx` or inside `ChatPanel.tsx`).

- [ ] **Step 2: Build an actors map**

Add a Zustand `actors-store.ts`:
```ts
import { create } from "zustand";
import type { Actor } from "@/lib/actor/types";

interface ActorsState {
  byId: Record<string, Actor>;
  upsert: (a: Actor) => void;
}

export const useActorsStore = create<ActorsState>((set, get) => ({
  byId: {},
  upsert: (a) => set({ byId: { ...get().byId, [a.actorId]: a } }),
}));
```

- [ ] **Step 3: Render messages by actor**

Replace the OpenCode-driven messages render with:
```tsx
import { useSessionStore } from "@/stores/session-store";
import { useActorsStore } from "@/stores/actors-store";

export function MessageList() {
  const events = useSessionStore((s) => s.currentEvents());
  const actors = useActorsStore((s) => s.byId);
  return (
    <div className="space-y-2 p-4">
      {events.map((ev, i) => {
        if (ev.kind !== "chat_message") return null;
        const actor = actors[ev.actorId];
        return (
          <div key={i} className="flex gap-2">
            <div className="font-medium">{actor?.displayName ?? ev.actorId}:</div>
            <div>{ev.text}</div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Verify the rest of ChatPanel still typechecks**

```bash
pnpm typecheck
```
Expected: there will be errors from sites that reference the OLD session-store fields (e.g., `messages`, `selectedModel`). Mark these `// TODO Phase 1E removal` and stub them temporarily where ChatPanel renders, OR delete OpenCode-coupled UI that we know is going away.

For Phase 1, the simplest approach: feature-flag those branches with `if (false)` returns so they typecheck without rendering. Aim to delete cleanly in Task 1E.3.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/chat packages/app/src/stores/actors-store.ts
git commit -m "feat(chat): render messages by actor (events-based)"
```

---

### Task 1D.3: Session list from Supabase

**Files:**
- Create: `packages/app/src/stores/session-list-store.ts`
- Modify: ChatPanel sidebar component

- [ ] **Step 1: Create store**

```ts
import { create } from "zustand";
import { listSessionsForUser, type SessionRow } from "@/lib/supabase-client";
import { useAuthStore } from "./auth-store";

interface SessionListState {
  rows: SessionRow[];
  loading: boolean;
  load: () => Promise<void>;
}

export const useSessionListStore = create<SessionListState>((set) => ({
  rows: [],
  loading: false,
  load: async () => {
    const sess = useAuthStore.getState().session;
    if (!sess) return;
    set({ loading: true });
    const rows = await listSessionsForUser(sess.user_id);
    set({ rows, loading: false });
  },
}));
```

- [ ] **Step 2: Wire into sidebar**

In the sidebar component (find by grepping for the existing OpenCode session list rendering):
```tsx
import { useEffect } from "react";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionStore } from "@/stores/session-store";
import { mqttSubscribe } from "@/lib/mqtt-bridge";

export function SessionSidebar() {
  const { rows, loading, load } = useSessionListStore();
  const setCurrent = useSessionStore((s) => s.setCurrent);

  useEffect(() => { load(); }, [load]);

  const onPick = async (id: string) => {
    setCurrent(id);
    await mqttSubscribe(id);
  };

  return (
    <ul className="overflow-y-auto">
      {loading && <li className="p-2">Loading...</li>}
      {rows.map((r) => (
        <li key={r.id} onClick={() => onPick(r.id)} className="cursor-pointer p-2 hover:bg-gray-100">
          {r.title}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: Manual smoke test**

```bash
pnpm tauri:dev
```
Expected: after login, sidebar lists sessions from Supabase.

- [ ] **Step 4: Commit**

```bash
git add packages/app
git commit -m "feat(sidebar): session list from Supabase"
```

---

### Task 1D.4: Subscribe + dispatch wiring

**Files:**
- Modify: app root or top-level effect

- [ ] **Step 1: Start the event bus + connect MQTT after login**

In `App.tsx`:
```tsx
import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useSessionEventBus } from "@/stores/session-event-bus";
import { useSessionStore } from "@/stores/session-store";
import { invoke } from "@tauri-apps/api/core";

export function AuthedApp() {
  const session = useAuthStore((s) => s.session);
  const start = useSessionEventBus((s) => s.start);
  const pushEvent = useSessionStore((s) => s.pushEvent);

  useEffect(() => {
    if (!session) return;
    (async () => {
      await invoke("mqtt_connect", {
        brokerHost: import.meta.env.VITE_MQTT_HOST,
        brokerPort: Number(import.meta.env.VITE_MQTT_PORT ?? 8883),
        username: session.access_token,
        password: "",
        clientId: `teamclaw_${session.user_id}_${crypto.randomUUID().slice(0, 8)}`,
      });
      await start();
    })();
  }, [session, start]);

  // Dispatch bus events into session-store
  const events = useSessionEventBus((s) => s.perSession);
  useEffect(() => {
    Object.entries(events).forEach(([sid, evs]) => {
      const cur = useSessionStore.getState().events[sid] ?? [];
      if (evs.length > cur.length) {
        for (let i = cur.length; i < evs.length; i++) pushEvent(sid, evs[i]);
      }
    });
  }, [events, pushEvent]);

  return <ExistingShell />;
}
```

- [ ] **Step 2: Add VITE_MQTT_HOST/PORT to `.env.development`**

- [ ] **Step 3: Smoke test**

```bash
pnpm tauri:dev
```
Expected: after login, MQTT connects (verify in logs); pick session → subscribed to topic.

- [ ] **Step 4: Commit**

```bash
git add packages/app
git commit -m "feat(app): connect MQTT and bridge bus to session-store post-login"
```

---

## Phase 1E — Round-Trip + Cleanup

### Task 1E.1: Send-message wiring

**Files:**
- Modify: chat input component (find by grep)

- [ ] **Step 1: Implement send action**

```tsx
import { mqttPublishEnvelope } from "@/lib/mqtt-bridge";
import { actorEventToEnvelopeJson } from "@/lib/actor/event-mapper";
import { useAuthStore } from "@/stores/auth-store";
import { useSessionStore } from "@/stores/session-store";

export function ChatInput() {
  const [text, setText] = useState("");
  const session = useAuthStore((s) => s.session);
  const sid = useSessionStore((s) => s.currentSessionId);

  const send = async () => {
    if (!session || !sid || !text.trim()) return;
    const env = actorEventToEnvelopeJson({
      kind: "chat_message",
      actorId: session.user_id,
      timestampMs: Date.now(),
      text,
      mentionActorIds: [],
    });
    await mqttPublishEnvelope(sid, env);
    setText("");
  };

  return (
    <div className="border-t p-2">
      <input
        className="w-full rounded border px-2 py-1"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
        placeholder="Send a message"
      />
    </div>
  );
}
```

- [ ] **Step 2: Smoke test in single window**

```bash
pnpm tauri:dev
```
Type a message → should round-trip back through MQTT and render. (Self-echo since we're subscribed to our own topic.)

- [ ] **Step 3: Commit**

```bash
git add packages/app
git commit -m "feat(chat): publish ChatMessage on send"
```

---

### Task 1E.2: Two-window manual test

- [ ] **Step 1: Build dev**

```bash
pnpm tauri:dev
```
Open the app. Note the workspace label.

- [ ] **Step 2: Open a second window**

Use teamclaw's existing multi-window UI (whichever menu opens a new window in current v1). Log in with the same Supabase account. Pick the same session.

- [ ] **Step 3: Round-trip test**

In window A, send "hello from A". Window B should receive it within 1–2 s.
In window B, send "hello from B". Window A should receive it.

- [ ] **Step 4: If broken, debug at the layer that surfaces the problem**

- Tauri Rust logs (`RUST_LOG=info`): is `mqtt_publish` being called? Is the broker accepting?
- EMQX dashboard: are the messages on the topic?
- Frontend console: is `listenForEnvelopes` firing?
- Mapper: does `envelopeJsonToActorEvent` return non-null?

Fix at the right layer; do not bypass.

- [ ] **Step 5: Commit any fixes; otherwise no commit**

---

### Task 1E.3: Delete OpenCode

**Files:**
- Delete: `src-tauri/binaries/opencode-*`
- Delete: `src-tauri/src/commands/opencode.rs`
- Delete: `packages/app/src/lib/opencode/` (whole dir)
- Delete: `packages/app/src/stores/session-sse-{lifecycle,message,tool}-handlers.ts`
- Modify: `packages/app/package.json` (remove `@opencode-ai/sdk`)
- Modify: `tauri.conf.json` (remove `binaries/opencode` from `externalBin`)
- Modify: `src-tauri/src/lib.rs` (deregister opencode handlers; remove `pub mod opencode`)
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Identify all OpenCode references**

```bash
cd /Volumes/openbeta/workspace/teamclaw-v2
grep -rln "opencode\|OpenCode\|@opencode-ai" src-tauri/src packages/app/src tauri.conf.json packages/app/package.json | sort -u
```

- [ ] **Step 2: Delete the obvious files**

```bash
rm -rf src-tauri/binaries/opencode-* src-tauri/src/commands/opencode.rs packages/app/src/lib/opencode
rm -f packages/app/src/stores/session-sse-lifecycle-handlers.ts \
      packages/app/src/stores/session-sse-message-handlers.ts \
      packages/app/src/stores/session-sse-tool-handlers.ts
```

- [ ] **Step 3: Remove npm dep**

```bash
pnpm --filter @teamclaw/app remove @opencode-ai/sdk
```

- [ ] **Step 4: Update tauri.conf.json**

Remove the `"binaries/opencode"` entry from `externalBin`, leaving `"binaries/teamclaw-introspect"`.

- [ ] **Step 5: Patch lib.rs**

Find and remove:
- `pub mod opencode_state;` (or whatever module declarations refer to opencode)
- All entries in `tauri::generate_handler![...]` referring to `opencode::`
- Any state managed for opencode (`OpenCodeState`)

- [ ] **Step 6: Patch commands/mod.rs**

Remove `pub mod opencode;` and any `pub use` re-exports.

- [ ] **Step 7: Resolve all import errors**

```bash
pnpm rust:check
```
Expected: a wave of errors. For each:
- If a store imports from `lib/opencode/`, replace the import with the closest `lib/actor/` equivalent or remove the dead branch.
- If a Tauri call uses `start_opencode` etc., remove the call site (these are no-op in Phase 1).

Iterate until clean.

```bash
pnpm typecheck
```
Iterate until clean.

- [ ] **Step 8: Run all tests**

```bash
pnpm test:unit
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: all green.

- [ ] **Step 9: Smoke**

```bash
pnpm tauri:dev
```
Expected: app boots, login works, session list works, two-window chat works, no OpenCode in process tree.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore(opencode): remove sidecar, SDK, stores, and binary references"
```

---

### Task 1E.4: Phase 1 acceptance + cleanup

- [ ] **Step 1: Run full pipeline**

```bash
pnpm rust:check
pnpm typecheck
pnpm lint
pnpm test:unit
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```
Expected: all green.

- [ ] **Step 2: Update worktree README**

Create or update `README.md` at worktree root (top of file):
```markdown
# TeamClaw v2 (worktree: v2/amuxd-architecture)

This branch is the v2 architecture migration described in
`docs/superpowers/specs/2026-05-08-amuxd-architecture-design.md`.

OpenCode sidecar is removed. Local dev requires:
- Supabase project URL + anon key (`packages/app/.env.development`, `src-tauri` env vars)
- EMQX broker host/port (`packages/app/.env.development`)
```

- [ ] **Step 3: Tag completion**

```bash
git commit --allow-empty -m "chore: phase 1 complete (auth + MQTT + actor model + clean OpenCode)"
git tag v2-phase-1-done
```

- [ ] **Step 4: Hand off**

Phase 2 plan (daemon installer + ACP `start_agent` + agent streaming + permissions) is the next plan to write. Do not start Phase 2 implementation until that plan is approved.

---

## Self-Review Checklist

After this plan is executed:
- All Phase 0 + 1 acceptance criteria met (top of doc)
- No `unimplemented!()` or `not_implemented` strings remain in code paths the user can hit
- Rust + TS test suites green; clippy + lint + typecheck clean
- Two-window chat round trip verified manually
- OpenCode entirely removed from worktree
- README updated with v2 dev requirements

If any of these miss, the plan is not done — open follow-up tasks before claiming completion.
