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
- Spawn `fix_path_env()` on a dedicated thread **before** `tauri::Builder::default()`, but don't block on its result
- Use a global `std::sync::OnceLock<()>` as a completion signal (set by the spawned thread when PATH is applied)
- `start_opencode` checks this signal before spawning the sidecar (sidecar inherits process PATH)

**Implementation detail**: `fix_path_env()` calls `std::env::set_var`, which is `unsafe` in multi-threaded contexts on Rust 1.83+. To mitigate: spawn the PATH-reading thread before `tauri::Builder::default()` (while still single-threaded for env reads), capture the result, and apply `set_var` before the Builder starts constructing. The OnceLock simply signals completion so downstream code knows PATH is ready. Alternatively, keep `fix_path_env()` synchronous but move the slow shell spawn to a pre-cached approach: try reading a cached PATH from `~/.teamclaw/cached-path.txt` first, fall back to shell spawn only if missing.

**Chosen approach**: Keep `fix_path_env()` synchronous and before `Builder::default()` (avoiding `set_var` safety issues), but optimize it by caching the PATH result. This is simpler and avoids the multi-threaded `set_var` problem entirely. The ~50-200ms savings come from cache hits on subsequent launches.

**Files**: `src-tauri/src/lib.rs`

**Constraints**:
- PATH must be set before any child process is spawned (sidecar, shell commands)
- `std::env::set_var` must be called while still effectively single-threaded (before Builder construction)
- Cache file (`~/.teamclaw/cached-path.txt`) must be invalidated when shell profile changes (use file mtime of `~/.zshrc` / `~/.bashrc` as cache key)

### 2. Parallel File I/O Before Sidecar Spawn

**Problem**: In `start_opencode`, 5 operations run sequentially before the sidecar is spawned:

```
ensure_default_permissions → ensure_inherent_config → ensure_inherent_skills
→ resolve_sidecar_binary_paths → read_keyring_secrets
```

Three of these (`ensure_default_permissions`, `ensure_inherent_config`, `resolve_sidecar_binary_paths`) all read/write `opencode.json` and must remain sequential with each other. The remaining two (`ensure_inherent_skills` writes to `.opencode/skills/`, `read_keyring_secrets` reads the OS keyring) are independent and can run in parallel.

**Solution**:
- Group the three `opencode.json` writers into a sequential chain, wrapped in a single `spawn_blocking`
- Run `ensure_inherent_skills` and `read_keyring_secrets` in parallel with the config chain via `tokio::join!`
- `resolve_config_secret_refs` depends on both the config chain AND keyring results completing, so it runs after the `tokio::join!`

**Before** (serial, total = sum of all):
```
ensure_permissions → ensure_config → ensure_skills → resolve_paths → read_keyring
```

**After** (partially parallel, total ≈ max of the two branches):
```
┌─ ensure_permissions → ensure_config → resolve_paths ─┐
├─ ensure_skills ──────────────────────────────────────┼──→ resolve_secret_refs → spawn
└─ read_keyring ───────────────────────────────────────┘
```

**Files**: `src-tauri/src/commands/opencode.rs`

**Constraints**:
- `ensure_default_permissions`, `ensure_inherent_config`, and `resolve_sidecar_binary_paths` all read/write `opencode.json` — they MUST remain sequential
- `resolve_config_secret_refs` must not begin until ALL `opencode.json` mutations are complete (it reads the raw file content for string replacement)
- `ensure_inherent_skills` and `read_keyring_secrets` have no file dependencies on `opencode.json` and are safe to parallelize

### 3. Early Sidecar Launch from Rust Setup Hook (Core Optimization)

**Problem**: The sidecar doesn't start until the frontend renders and sends an `invoke("start_opencode")` call. The window load + React render adds ~200-500ms of dead time before the sidecar even begins starting.

**Solution**:

**3a. Persist workspace path on Rust side**:
- After successful `start_opencode`, write workspace path to `~/.teamclaw/last-workspace.json`
- Format: `{"workspace_path": "/path/to/workspace"}`
- Write is fire-and-forget (non-blocking, errors logged)

**3b. Early launch in setup hook**:
- In `setup`, read `last-workspace.json` (PATH is already set since `fix_path_env` runs synchronously before Builder)
- If a valid workspace path is found, spawn the full sidecar startup logic (file I/O, keyring, sidecar spawn) as an async task
- Store the in-flight future's result in a `Mutex<Option<EarlyLaunchState>>` on `OpenCodeState`, where `EarlyLaunchState` holds the workspace path and a `tokio::sync::watch::Sender/Receiver` for the result

**3c. Frontend invoke hits cache**:
- When frontend calls `start_opencode` with the same workspace path, check if an early launch is in progress or completed for that path
- If match and succeeded: return the cached result immediately
- If match and failed: clear the early launch state, proceed with a fresh attempt (supports retry)
- If mismatch (user changed workspace): clear the early launch state, proceed with normal restart logic

**Why `watch` instead of `OnceCell`**: `OnceCell` can only be set once — if the early launch fails, subsequent retries cannot reset it. A `watch` channel (or `Mutex<Option<Result<...>>>`) allows the state to be cleared on failure, enabling the retry flow from the frontend's error screen.

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
- `~/.teamclaw/` directory doesn't exist → `create_dir_all` before writing `last-workspace.json`
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

With early sidecar launch from Rust, this delay is unnecessary. The original 300ms delay was a heuristic to give `useOpenCodePreload` time to fire first, but the preloader's deduplication (`hasPreloadFor` check + shared promise in `preloader.ts`) already handles double-invocation correctly. React strict mode's double-mount is also safe because the preloader returns the same in-flight promise.

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
| 1 | Cache `fix_path_env()` PATH result | `lib.rs` | ~50-200ms (on cache hit) |
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

## Debugging

Set `TEAMCLAW_DISABLE_EARLY_LAUNCH=1` to disable the early sidecar launch (optimization 3) for debugging. When set, the app falls back to the frontend-triggered launch flow.

## Non-Goals

- No splash screen or UI flow changes
- No Tauri plugin lazy loading (risk of side effects)
- No frontend chunk splitting changes
