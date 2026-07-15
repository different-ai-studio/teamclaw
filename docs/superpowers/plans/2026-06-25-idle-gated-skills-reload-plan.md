# Idle-Gated Skills Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically apply skills refreshes on remote daemons only when the affected workspace has no active turn.

**Architecture:** Reuse the existing `RuntimeRefreshCoordinator` and `RuntimeSupervisor.apply_refresh()` flow. Add an idle-aware auto-apply method on `RuntimeSupervisor`, a workspace busy query on `RuntimeManager`, and a lightweight background loop started with the existing refresh watcher.

**Tech Stack:** Rust, Tokio, amuxd runtime manager, existing daemon unit tests.

---

### Task 1: Workspace Busy Detection

**Files:**
- Modify: `apps/daemon/src/runtime/manager/workspace_query.rs`
- Test: `apps/daemon/src/runtime/refresh_watch.rs`

- [ ] **Step 1: Write failing tests**

Add tests proving a workspace is busy when a handle is active or checked out, and idle when only an idle handle exists.

- [ ] **Step 2: Run tests to verify failure**

Run: `cargo test -p amuxd runtime_workspace_busy_detection -- --nocapture`
Expected: fails because `workspace_has_active_turn` does not exist.

- [ ] **Step 3: Implement busy detection**

Add `RuntimeManager::workspace_has_active_turn(workspace_path, workspace_id) -> bool`.
It should match the existing workspace matching rules and return true when a
matching handle has `status == Active` or `event_rx.is_none()`.

- [ ] **Step 4: Verify tests pass**

Run: `cargo test -p amuxd runtime_workspace_busy_detection -- --nocapture`
Expected: pass.

### Task 2: Auto-Apply Coordinator Behavior

**Files:**
- Modify: `apps/daemon/src/runtime/refresh.rs`
- Modify: `apps/daemon/src/runtime/supervisor.rs`
- Test: `apps/daemon/src/runtime/supervisor.rs`

- [ ] **Step 1: Write failing tests**

Add tests for:
- idle pending skills refresh auto-applies and returns clean,
- active workspace leaves pending state and sets `auto_apply_blocked_by_active_runtime=true`,
- after the workspace becomes idle, auto apply clears the pending state.

- [ ] **Step 2: Run tests to verify failure**

Run: `cargo test -p amuxd auto_apply -- --nocapture`
Expected: fails because the auto-apply API does not exist.

- [ ] **Step 3: Implement refresh helpers**

Add coordinator helpers to list pending workspace states and mark whether auto
apply is blocked by active runtime.

- [ ] **Step 4: Implement supervisor auto apply**

Add `RuntimeSupervisor::auto_apply_pending_refreshes()` and
`RuntimeSupervisor::auto_apply_pending_refresh_for_workspace(...)`. Only
auto-apply eligible kinds from the design. If busy, keep pending and mark
blocked. If idle, call `apply_refresh()`.

- [ ] **Step 5: Verify tests pass**

Run: `cargo test -p amuxd auto_apply -- --nocapture`
Expected: pass.

### Task 3: Background Auto-Applier Loop

**Files:**
- Modify: `apps/daemon/src/runtime/supervisor.rs`
- Modify: daemon bootstrap file that starts refresh watchers, likely `apps/daemon/src/main.rs` or `apps/daemon/src/http/server.rs`
- Test: existing supervisor tests

- [ ] **Step 1: Write failing test**

Add a Tokio test that starts the auto-applier loop, records a skills change, and
observes the state become clean.

- [ ] **Step 2: Run test to verify failure**

Run: `cargo test -p amuxd auto_applier_loop -- --nocapture`
Expected: fails because the loop starter does not exist.

- [ ] **Step 3: Implement loop starter**

Add `RuntimeSupervisor::start_refresh_auto_applier()` that ticks about once per
second and calls `auto_apply_pending_refreshes()`.

- [ ] **Step 4: Wire startup**

Start the loop wherever `RuntimeSupervisor` is constructed for the HTTP/runtime
daemon path. Keep it internal; no new external API.

- [ ] **Step 5: Verify tests pass**

Run: `cargo test -p amuxd auto_applier_loop -- --nocapture`
Expected: pass.

### Task 4: Full Verification

**Files:**
- All modified daemon files

- [ ] **Step 1: Format**

Run: `cargo fmt --manifest-path apps/daemon/Cargo.toml`
Expected: no errors.

- [ ] **Step 2: Targeted tests**

Run: `cargo test -p amuxd refresh -- --nocapture`
Expected: pass.

- [ ] **Step 3: Broader daemon tests**

Run: `pnpm daemon:test`
Expected: pass or report exact failures.

- [ ] **Step 4: Commit implementation**

Stage only files changed for this implementation and commit with:
`feat(daemon): auto-apply skills refresh when idle`
