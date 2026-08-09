# Local-agent send fast path

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When the only mentioned agent is this machine’s local daemon, deliver the user message to the agent over loopback first; Cloud write is best-effort; MQTT fan-out is idempotent via existing `message_id` dedup.

**Architecture:** Outbox detects local-only mentions → `runtimeStart` over existing local `/v1/rpc` (pass local `worktree`, skip Cloud workspace-hint round-trips) → new loopback `POST /v1/session-live/ingest` that runs the same `route_session_message` sink as MQTT `message.created` → then MQTT publish + Cloud `insertOutgoingMessage` (Cloud failure does not fail delivery). Remote / multi-agent mentions keep today’s Cloud → MQTT → ensure order.

**Tech Stack:** amuxd axum HTTP bridge, teamclu protobuf `LiveEventEnvelope` / `SessionMessageEnvelope`, desktop outbox-sender, existing `teamclu-rpc` local HTTP path.

---

### Task 1: Daemon live-ingest bridge + HTTP route

**Files:**
- Modify: `apps/daemon/src/http/state.rs` — add `LocalLiveIngestRequest` + channel on `HttpState`
- Create/Modify: `apps/daemon/src/http/live_ingest.rs` — `POST /v1/session-live/ingest`
- Modify: `apps/daemon/src/http/routes.rs` — register route
- Modify: `apps/daemon/src/daemon/server.rs` (or mqtt/actor loop wiring) — attach bridge, decode envelope, call `route_session_message`

**Step 1:** Failing unit/integration test: POST ingest with a `message.created` body invokes routing (or marks message processed) and a second ingest with the same `message_id` is a no-op.

**Step 2:** Implement bridge + handler mirroring `http/rpc.rs` pattern (oneshot reply, actor-owned side effects).

**Step 3:** Wire channel where `local_rpc_tx` is attached today.

---

### Task 2: Desktop client helper to ingest over loopback

**Files:**
- Modify: `packages/app/src/lib/daemon-local-client.ts` (or new `local-live-ingest.ts`)
- Test: `packages/app/src/lib/__tests__/…`

**Step 1:** Failing test for encoding LiveEventEnvelope and POSTing to ingest URL.

**Step 2:** Implement `ingestSessionLiveLocally(envelopeBytes)` using existing daemon port discovery.

---

### Task 3: Outbox local-only reorder

**Files:**
- Modify: `packages/app/src/services/outbox-sender.ts`
- Modify: `packages/app/src/services/__tests__/outbox-sender.test.ts`
- Keep: ChatPanel enqueue-without-blocking-hint + `kickOutboxSender` from current branch WIP

**Step 1:** Test — when `mentionActorIds` is only the known local daemon actor:
  1. local `runtimeStart` (or ensure) called
  2. local ingest called
  3. MQTT publish called
  4. Cloud insert called; if Cloud throws, entry still `delivered`

**Step 2:** Implement branch; non-local mentions unchanged (Cloud → MQTT → ensure).

**Step 3:** Local `runtimeStart` uses local `worktree` from workspace store; do not block on Cloud workspace UUID resolution.

---

### Task 4: Verify

- `pnpm exec vitest run` outbox + local client tests in `packages/app`
- `cargo test` for new daemon ingest tests (scoped)
- Manual checklist: solo local agent send → spinner immediately → agent replies without waiting on Cloud
