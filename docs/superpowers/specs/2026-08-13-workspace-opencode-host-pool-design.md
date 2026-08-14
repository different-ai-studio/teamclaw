# Workspace-scoped OpenCode Host Pool — Design

Date: 2026-08-13
Status: Implemented

## Goal

Allow sessions and cron jobs from different workspaces to run concurrently
without `env_snapshot_conflict`, while preserving process-level environment
isolation and bounding local resource usage.

The core architectural change is:

> A workspace isolation domain owns an OpenCode host. An environment hash is a
> revision of that host, not a device-wide admission lock.

## Problem

OpenCode accepts a `directory` on session APIs, so one `opencode serve` process
can provide different working directories. Its inherited environment is still
process-global. Team secrets, personal variables, provider credentials, and
system-derived bindings can therefore differ by workspace even though the HTTP
API supports multiple directories.

The former single global host compared the incoming environment fingerprint
with the process's active fingerprint. This protected against environment
leakage, but turned normal multi-workspace usage into `env_snapshot_conflict`.
Making the comparison more permissive would silently run a session under the
wrong secrets and is not acceptable.

Cron exposed the problem more often because selecting a workspace changes its
working directory after another workspace may already hold routes on the global
host. Cron also needed the same workspace environment assembly path as desktop
and workspace-aware gateway spawns.

## Decisions

### 1. Isolation domain is the host ownership key

Use a stable `IsolationDomainKey`:

```text
Workspace(<workspace_id>)
UnscopedAgent(<team_id>, <actor_id>)
```

- Registered workspace sessions use `Workspace(workspace_id)`.
- Git worktrees use the parent workspace's domain. A worktree never creates a
  domain merely because its canonical directory differs.
- A global cron job resolves the daemon default workspace first and uses that
  workspace's domain. "Global" remains a scheduling/storage scope, not an
  environment scope.
- Gateway sessions without any resolvable workspace use `UnscopedAgent`; their
  scratch directories share a host only when team and actor identity match.
- Canonical paths remain route attributes for OpenCode's `directory` query, but
  paths do not define host ownership.

Callers pass a resolved execution context:

```text
ExecutionContext {
  isolation_domain,
  workspace_id?,
  workspace_root?,
  working_directory,
  spawn_env,
}
```

### 2. Environment fingerprint is a process-env revision

`ProcessEnvRevision` is a cryptographic hash of the complete, effective
environment map inherited by `opencode serve`. Values remain hashed and must
never be logged.

The revision includes only process-inherited bindings. Directory-scoped files
such as `opencode.json`, skills, and MCP definitions are not included unless
their contents are materialized into inherited environment variables. This
avoids restarting a host for configuration OpenCode already resolves by
directory.

All spawn entry points use one environment assembly service:

```text
Desktop ─┐
Cron ────┼─> resolve ExecutionContext
Gateway ─┘          │
                    ├─> assemble workspace runtime env
                    └─> HostPool.acquire(domain, process_env_revision)
```

Cron resolves the real workspace id along with its path. Falling back to a
path-only synthetic domain is not allowed.

### 3. One current generation per domain, with graceful replacement

`OpenCodeHostPool` owns domain slots:

```text
OpenCodeHostPool
  domains: DomainKey -> DomainSlot

DomainSlot
  current: HostGeneration?
  draining: HostGeneration[]
  activation_lock

HostGeneration
  generation_id
  process_env_revision
  ServeSupervisor
  routes / permissions / questions / SSE tasks
  lifecycle: starting | ready | draining | stopped
```

Acquisition behavior:

1. No current generation: spawn one with the requested snapshot.
2. Revision matches current: attach to current.
3. Revision differs and current has no routes: stop and replace current.
4. Revision differs and current has routes:
   - start a new generation with the new snapshot;
   - atomically publish it as current after health check;
   - mark the old generation draining;
   - existing sessions stay on the old generation;
   - new sessions attach to the new generation;
   - stop the old generation after its final route detaches.

A per-domain activation lock prevents duplicate replacements. Different domains
can start or attach concurrently.

This is a rolling replacement, not an in-place environment mutation. A session
never changes environment during its lifetime.

### 4. Route identity includes host generation

Route, permission, question, SSE, and command state lives in each
`HostGeneration`. Manager-facing session attachments store a host-generation
handle in addition to the OpenCode session id.

No code may locate a route by OpenCode session id across the entire pool without
also knowing its host generation. This avoids accidental collisions and makes
detach deterministic.

Model/provider settings APIs resolve a workspace domain before choosing a host.
If that domain has no current host, they may prewarm it. A provider/auth change
invalidates affected domain revisions; it does not terminate active sessions.

### 5. Capacity is bounded; active sessions are never evicted

Validated policy:

- idle host TTL: **5 minutes (300 seconds)** after its final route detaches;
- steady-state soft limit: **2** ready host processes;
- transient hard limit: **3** processes, allowing one rolling replacement;
- idle hosts are evicted least-recently-used before starting another host;
- draining hosts with active routes are never killed for capacity;
- when the hard limit is reached and every candidate is active, acquisitions
  wait in FIFO order until capacity is released;
- the caller's existing startup/turn deadline bounds the wait.

Capacity waiting returns a specific `host_capacity_timeout` error with domain
and counts, never `env_snapshot_conflict`. Metrics and diagnostics expose host
counts, queue depth, domain (non-secret identifier), lifecycle, route count,
revision prefix, and idle age.

The prerequisite measured roughly 340–365 MiB RSS per idle host on
Darwin/arm64, so 300/2/3 deliberately favors bounded desktop memory over broad
concurrency. These are daemon constants in the first release, not user-facing
settings.

## Multi-process prerequisite

The prerequisite passed with official OpenCode 1.18.18 on Darwin/arm64 using
OpenAI OAuth. Multiple `serve` processes shared normal OpenCode user data and
config roots while:

1. listening on separate loopback ports;
2. running parallel sessions in different directories;
3. making parallel model calls and tool executions;
4. seeing provider authentication in both processes;
5. restarting one process and resuming its session;
6. persisting concurrently without database lock, corruption, or cross-session
   event delivery.

The measured result selected shared normal OpenCode user state. No
daemon-managed per-domain data-root copy is required.

## Failure handling

- **New generation fails health check:** keep the old current generation;
  acquisition fails with the spawn/health error. Do not drain the healthy host.
- **Current host crashes:** mark only that generation unavailable. Sessions
  bound to it use existing resume behavior after replacement.
- **Draining host crashes:** only its remaining sessions are affected; current
  generation remains available.
- **Environment assembly fails:** fail before host acquisition. Never fall back
  to a bare environment for a workspace-aware spawn.
- **Capacity exhausted:** queue with observable position and deadline; never
  reuse a host from another domain.
- **Daemon shutdown:** stop all generations and their registered process groups.

Gateway's "degrade to bare env" behavior remains only for truly unscoped scratch
sessions. Once a workspace is resolved, assembly failure is explicit because
silently dropping workspace credentials breaks isolation semantics.

## Diagnostics and user experience

`env_snapshot_conflict` is removed from normal attach behavior. Environment
settings diagnostics are domain-specific:

- active revision;
- requested revision;
- whether a rolling replacement is starting;
- current and draining route counts;
- queued capacity wait;
- last assembly or spawn error.

Runtime reload affects the selected workspace domain. It creates or requests a
new generation and does not globally interrupt other workspaces.

Cron history distinguishes environment assembly failure, host startup failure,
host capacity timeout, and model/turn failure.

## Testing

### Unit

- worktree and root directory resolve to the same workspace domain;
- global cron resolves to the default workspace domain;
- unscoped gateways are separated by team/actor;
- equal revision reuses current generation;
- changed revision with active routes rolls generations;
- changed revision without routes replaces in place;
- concurrent acquisition creates only one generation;
- LRU idle eviction and FIFO capacity waiting;
- active/draining hosts are never capacity-evicted.

### Integration

- concurrent turns in two workspaces with different sentinel env values each
  observe only their own value;
- cron in workspace B succeeds while a desktop turn remains active in
  workspace A;
- changing an env value sends new sessions to a new generation while an old
  session completes on the old value;
- hard-cap waiting resumes after a route detaches;
- permission/question routing and SSE remain generation-bound.

### Regression

- idle runtime eviction and retained-state cleanup;
- provider OAuth/config refresh;
- MCP injection cleanup;
- cron Run Now and scheduled execution;
- gateway sessions with and without a workspace.

## Security properties

- Environment values never cross isolation domains.
- A host generation receives one immutable process environment.
- Revision hashes and logs reveal no secret values.
- Capacity pressure never causes cross-domain host reuse.
- Directory canonicalization remains mandatory, but cannot grant access to a
  different domain.

## Out of scope

- Per-session OpenCode processes.
- User-configurable host limits in the first release.
- Changing Cloud API or client protocols.
- Migrating historical OpenCode session storage.
- Treating workspace config files as process-env revision inputs.
