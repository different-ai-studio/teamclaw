# Startup Speed Optimization Design

## Goal

Reduce TeamClaw's startup time by ~1-2 seconds through parallelization and early sidecar launch, without changing the existing UI flow.

## Current Startup Critical Path

```
fix_path_env() [~50-200ms, blocking, spawns login shell]
    ↓
Tauri Builder [plugin registration, synchronous]
    ↓
Setup Hook [RAG server, tray, event handlers]
    ↓
Window creation + Webview load
    ↓
React render [main.tsx → App.tsx]
    ↓
useOpenCodePreload() → invoke("start_opencode")
    ↓
Rust start_opencode:
  ensure_default_permissions()     [sync file I/O]
  ensure_inherent_config()         [sync file I/O]
  ensure_inherent_skills()         [sync file I/O]
  resolve_sidecar_binary_paths()   [sync file I/O]
  read_keyring_secrets()           [spawn_blocking]
  resolve_config_secret_refs()     [file I/O]
    ↓
Sidecar spawn + wait for "ready" [1-10s, biggest bottleneck]
    ↓
SSE connect → openCodeReady = true → UI usable
```

**Total: ~2-15 seconds** (dominated by sidecar startup).

## Optimizations

### 1. Async `fix_path_env()`

**Problem**: `fix_path_env()` runs synchronously at the very start of `run()`, blocking Tauri Builder construction for ~50-200ms while spawning a login shell.

**Solution**:
- Move `fix_path_env()` into the `setup` hook, executed via `tauri::async_runtime::spawn_blocking`
- Use a global `tokio::sync::OnceCell<()>` (or `std::sync::OnceLock`) as a completion signal
- `start_opencode` awaits this signal before spawning the sidecar (sidecar inherits process PATH)

**Files**: `src-tauri/src/lib.rs`

**Constraints**:
- PATH must be set before any child process is spawned (sidecar, shell commands)
- The `fix_path_env` completion signal must be awaitable from async context

### 2. Parallel File I/O Before Sidecar Spawn

**Problem**: In `start_opencode`, 5 operations run sequentially before the sidecar is spawned:

```
ensure_default_permissions → ensure_inherent_config → ensure_inherent_skills
→ resolve_sidecar_binary_paths → read_keyring_secrets
```

These are all independent of each other.

**Solution**:
- Wrap the first 4 sync functions in `spawn_blocking`
- Run all 5 operations in parallel via `tokio::join!`
- `resolve_config_secret_refs` depends on keyring results, so it stays sequential after the join

**Before** (serial, total = sum of all):
```
ensure_permissions → ensure_config → ensure_skills → resolve_paths → read_keyring
```

**After** (parallel, total ≈ max of all):
```
┌─ ensure_permissions ─┐
├─ ensure_config ──────┤
├─ ensure_skills ──────┼──→ resolve_config_secret_refs → spawn sidecar
├─ resolve_paths ──────┤
└─ read_keyring ───────┘
```

**Files**: `src-tauri/src/commands/opencode.rs`

**Constraints**:
- `ensure_default_permissions` and `ensure_inherent_config` both read/write `opencode.json` — they are logically independent (permissions section vs mcp/skills sections), but write to the same file. Must ensure no concurrent writes corrupt the file.
- Solution: keep `ensure_default_permissions` and `ensure_inherent_config` sequential with each other (they share `opencode.json`), but parallel with `ensure_inherent_skills`, `resolve_sidecar_binary_paths`, and `read_keyring_secrets`.

**Revised parallel layout**:
```
┌─ ensure_permissions → ensure_config → resolve_paths ─┐
├─ ensure_skills ──────────────────────────────────────┼──→ resolve_secret_refs → spawn
└─ read_keyring ───────────────────────────────────────┘
```

### 3. Early Sidecar Launch from Rust Setup Hook (Core Optimization)

**Problem**: The sidecar doesn't start until the frontend renders and sends an `invoke("start_opencode")` call. The window load + React render adds ~200-500ms of dead time before the sidecar even begins starting.

**Solution**:

**3a. Persist workspace path on Rust side**:
- After successful `start_opencode`, write workspace path to `~/.teamclaw/last-workspace.json`
- Format: `{"workspace_path": "/path/to/workspace"}`
- Write is fire-and-forget (non-blocking, errors logged)

**3b. Early launch in setup hook**:
- In `setup`, after spawning `fix_path_env`, read `last-workspace.json`
- If a valid workspace path is found, spawn the full `start_opencode` logic (including file I/O, keyring, sidecar spawn) as an async task
- Store the result in `Arc<tokio::sync::OnceCell<Result<OpenCodeStatus, String>>>` on `OpenCodeState`

**3c. Frontend invoke hits cache**:
- When frontend calls `start_opencode` with the same workspace path, check if the early-launch OnceCell is already set (or in progress)
- If match: await the OnceCell and return its result
- If mismatch (user changed workspace): proceed with normal restart logic, clear the OnceCell

**Timing comparison**:

Before:
```
[Tauri init]──[Window]──[React render]──[invoke]──[file I/O]──[spawn]──[ready]
                                         ↑                                ↑
                                      sidecar starts                   UI usable
```

After:
```
[Tauri init]──[setup: early sidecar spawn]─────────────────────[ready]
              [Window]──[React render]──[invoke: hits cache]──────↑
                                                               UI usable
```

**Files**: `src-tauri/src/lib.rs`, `src-tauri/src/commands/opencode.rs`

**Edge cases**:
- `last-workspace.json` missing or unreadable → skip early launch, fallback to frontend-triggered flow
- Workspace directory deleted → sidecar fails, OnceCell stores Err, frontend receives error and shows error screen
- User switches workspace → frontend invoke path differs from cached path, triggers normal restart logic
- Concurrent calls → existing `start_lock` mutex serializes them; OnceCell ensures single initialization

### 4. Remove Frontend 300ms Delay

**Problem**: `useOpenCodeInit` has a hardcoded 300ms setTimeout when no preload is in progress:

```typescript
const delay = alreadyPreloading ? 0 : 300;
const timer = setTimeout(() => {
  startOpenCode(workspacePath)...
}, delay);
```

With early sidecar launch from Rust, this delay is unnecessary.

**Solution**: Remove the setTimeout, call `startOpenCode(workspacePath)` directly.

**Files**: `packages/app/src/hooks/useAppInit.ts` (`useOpenCodeInit`)

### 5. Defer Dependency Check

**Problem**: `useSetupGuide` runs `checkDependencies()` on mount, which spawns multiple shell processes (checking git, node, rust, etc.). These compete for CPU/IO with the sidecar startup.

**Solution**: Defer `checkDependencies()` until after `openCodeReady` is true. If setup was previously completed (localStorage flag), still skip entirely.

**Implementation**:
- `useSetupGuide` accepts `openCodeReady: boolean` parameter
- Only triggers `checkDependencies()` when `openCodeReady` is true (or when not in Tauri)
- If `decision === "skip"`, behavior unchanged (no check at all)

**Files**: `packages/app/src/hooks/useAppInit.ts` (`useSetupGuide`), `packages/app/src/App.tsx` (pass `openCodeReady` prop)

## Summary

| # | Optimization | Files | Expected Gain |
|---|-------------|-------|---------------|
| 1 | Async `fix_path_env()` | `lib.rs` | ~50-200ms |
| 2 | Parallel file I/O before sidecar | `opencode.rs` | ~100-300ms |
| 3 | Early sidecar launch from setup hook | `lib.rs` + `opencode.rs` | ~500-1500ms |
| 4 | Remove frontend 300ms delay | `useAppInit.ts` | 300ms |
| 5 | Defer dependency check | `useAppInit.ts` + `App.tsx` | indirect (less CPU contention) |

**Total expected gain: ~1-2 seconds**

## Testing Strategy

- **Manual timing**: Add `console.time`/`timeEnd` markers around key startup phases, compare before/after
- **Regression check**: Verify all startup scenarios still work:
  - Fresh install (no `last-workspace.json`)
  - Normal restart (workspace path cached)
  - Workspace switch (path mismatch)
  - Workspace directory deleted
  - Keychain locked (first-time secret access)
  - Dev mode (`OPENCODE_DEV_MODE=true`)
- **Cross-platform**: Test on macOS (primary), verify Windows/Linux builds compile and start correctly

## Non-Goals

- No splash screen or UI flow changes
- No Tauri plugin lazy loading (risk of side effects)
- No frontend chunk splitting changes
- No PATH caching to file (diminishing returns for added complexity)
