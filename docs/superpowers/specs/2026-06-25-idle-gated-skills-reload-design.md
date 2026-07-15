# Idle-gated automatic skills reload on remote daemons

**Date:** 2026-06-25
**Status:** Approved design
**Scope:** amuxd runtime refresh automation for remote/server deployments.

## Goal

When shared skills change on a remote server, amuxd should pick up the new
skills automatically without requiring a user to click "reload" and without
interrupting any agent that is currently executing a task.

The desired behavior is:

- Skills changes are detected by the existing refresh watcher.
- If the affected workspace is idle, amuxd reloads that workspace runtime
  automatically.
- If any agent in that workspace is currently executing a turn, amuxd waits.
- Once the active turn finishes, amuxd applies the pending reload before the
  next turn starts.
- Skills changes do not restart the whole daemon process.

## Background

The daemon already has most of the primitives:

- `apps/daemon/src/runtime/refresh_watch.rs` classifies changes under
  workspace, team, and global skill paths as `RefreshChangeKind::Skills`.
- `RuntimeRefreshCoordinator` stores pending refresh state and exposes the
  runtime refresh DTO used by workspace status.
- `RuntimeSupervisor.apply_refresh()` marks a workspace as applying, calls
  `reload_workspace()`, and clears or fails the pending state.
- `RuntimeSupervisor.reload_workspace()` prepares the workspace, stops runtime
  handles for that workspace, and evicts ACP hosts so the next runtime start
  picks up refreshed skills and config.
- `POST /v1/workspaces/:id/runtime/reload` already exposes this behavior for
  manual reloads.

The missing piece is an automatic, idle-aware applier that consumes pending
refresh state safely on remote daemons.

## Non-goals

- Do not restart the amuxd process for skills changes.
- Do not kill or interrupt an in-flight agent turn to apply a skills reload.
- Do not add a new Cloud API business endpoint.
- Do not bypass the existing `RuntimeRefreshCoordinator` and
  `RuntimeSupervisor` flow.
- Do not change Supabase schema or RLS.

## Architecture

Add an internal daemon service, tentatively named `RuntimeRefreshAutoApplier`.
It runs inside amuxd when a runtime supervisor is configured.

Responsibilities:

1. Observe workspaces with pending refresh state.
2. Decide whether a pending change can be applied automatically.
3. Gate automatic apply on workspace idleness.
4. Call `RuntimeSupervisor.apply_refresh()` for eligible workspaces.
5. Leave failed apply state in the existing refresh coordinator.

### Eligible change kinds

Automatic apply should be enabled for:

| Change kind | Behavior |
|---|---|
| `Skills` | Auto apply when workspace is idle. |
| `EnvVars` | Auto apply when workspace is idle. |
| `ProviderAuth` | Auto apply when workspace is idle. |
| `ProviderCatalog` | Auto apply when workspace is idle. |
| `Permissions` | Auto apply when workspace is idle. |
| `OpencodeJson` | Auto apply when workspace is idle. |

`Mcp` and `TeamclawConfig` remain pending for the first implementation unless
the current impact rules are intentionally relaxed. They may require broader
runtime or daemon-level semantics and should not be folded into the skills
change path casually.

### Idle gate

The idle check is workspace-scoped:

- Idle means no runtime handle in that workspace is currently executing a turn.
- Running means at least one active turn is checked out, streaming, awaiting
  tool output, cancelling, or otherwise not yet terminal.
- Merely having an inactive runtime handle is not enough to block apply.

Implementation should add a small query on `RuntimeManager`, for example:

```text
workspace_has_active_turn(workspace_path, workspace_id) -> bool
```

This must be based on runtime execution state, not just the presence of a
runtime handle, otherwise idle workspaces would never auto-reload.

### Trigger points

The auto applier should wake up from two places:

1. **Debounced polling:** a short interval, for example one second, scans pending
   refresh state and attempts idle workspaces.
2. **Turn lifecycle notification:** when a turn reaches a terminal state
   (`completed`, `failed`, `cancelled`, or runtime stopped), notify the applier
   to re-check that workspace immediately.

The polling path makes the system robust if a lifecycle notification is missed.
The lifecycle path avoids waiting for the next polling tick after a task ends.

### Before starting a new turn

Runtime start / turn dispatch should check for pending auto-applicable refresh
before accepting a new turn:

```text
if workspace has pending auto-applicable refresh and workspace is idle:
  apply_refresh(workspace)
then continue runtime start / turn dispatch
```

This prevents the common race where a skills change is pending, the old turn has
finished, and a new user prompt starts before the background applier wakes up.

## State model

Reuse the existing refresh states:

| State | Meaning |
|---|---|
| `Clean` | No pending refresh. |
| `Pending` | Change detected; reload not applied yet. |
| `Applying` | Auto or manual reload is currently applying. |
| `Failed` | Reload failed; `last_error` explains why. |

Extend the DTO semantics for `auto_apply_blocked_by_active_runtime`:

- `true`: the change is auto-applicable, but at least one active turn blocks it.
- `false`: either no active turn blocks apply, or the change is not
  auto-applicable.

This field lets UI and logs say "will apply after current task finishes" instead
of presenting a confusing permanent warning.

## Remote deployment boundary

Remote servers should use a process supervisor for daemon process restarts:

- `systemd` or the hosting platform restarts amuxd if the process exits.
- Suggested unit settings: `Restart=always`, `RestartSec=2`, and a watchdog or
  health check where available.
- amuxd should not self-restart for skills changes.

Process restart remains appropriate for:

- amuxd binary upgrades.
- daemon bootstrap config changes that cannot be applied by workspace runtime
  reload.
- unrecoverable daemon errors.

This keeps skills updates cheap and workspace-scoped, while leaving process
availability to the infrastructure layer.

## Error handling

- Apply failures call `mark_apply_failed()` and keep the pending context.
- The auto applier should not retry in a tight loop after failure. A failed
  state can be retried by a later file change, manual reload, or a conservative
  backoff.
- A reload race with newer changes must preserve the newer pending state; keep
  using the existing `RefreshApplyAttempt` revision checks.
- Internal writes from `prepare_workspace()` remain covered by the existing
  watcher suppression windows.

## Observability

Add structured logs for:

- pending refresh detected,
- auto apply deferred because a workspace has an active turn,
- auto apply started,
- auto apply succeeded,
- auto apply failed,
- pending refresh applied before new turn dispatch.

Useful fields: `workspace_id`, `workspace_path`, `change_kinds`, `source`,
`blocked_by_active_runtime`, and `error`.

## Testing

Unit tests:

- skills file change creates pending refresh state.
- idle workspace with pending `Skills` auto-applies and returns to clean.
- active workspace with pending `Skills` stays pending and sets
  `auto_apply_blocked_by_active_runtime=true`.
- when the active turn completes, pending `Skills` is applied.
- a new turn dispatch applies pending skills refresh first when workspace is
  idle.
- apply failure leaves `Failed` with `last_error`.
- rapid skill edits debounce and produce one apply.

Integration-style daemon tests:

- remote-style workspace skill update while an agent turn is running does not
  stop that turn.
- after the turn finishes, the next runtime sees the updated skills catalog.
- daemon process remains alive throughout the skills reload flow.

## Acceptance criteria

- A remote daemon picks up skills changes automatically without a manual reload.
- In-flight agent tasks are never interrupted by skills reload.
- New turns after an idle reload see the latest skills.
- Skills changes do not trigger daemon process restart.
- Existing manual `/runtime/reload` behavior continues to work.
