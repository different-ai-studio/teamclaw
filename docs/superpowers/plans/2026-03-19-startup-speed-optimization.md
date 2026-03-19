# Startup Speed Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce TeamClaw startup time by ~1-2 seconds through PATH caching, parallel file I/O, early sidecar launch, and frontend delay removal.

**Architecture:** Keep `fix_path_env()` synchronous but add file-based PATH caching. Parallelize independent pre-sidecar operations with `tokio::join!`. Launch the OpenCode sidecar from the Rust setup hook (before frontend renders) using a persisted workspace path. Remove unnecessary frontend delays.

**Tech Stack:** Rust (Tauri 2.0, tokio), TypeScript (React 19, Zustand)

**Spec:** `docs/superpowers/specs/2026-03-19-startup-speed-optimization-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/src/lib.rs` | Modify | PATH caching in `fix_path_env()`, early sidecar launch in `setup` hook |
| `src-tauri/src/commands/opencode.rs` | Modify | Parallel file I/O, `EarlyLaunchState`, workspace path persistence |
| `packages/app/src/hooks/useAppInit.ts` | Modify | Remove 300ms delay, defer dependency check |
| `packages/app/src/App.tsx` | Modify | Pass `openCodeReady` to `useSetupGuide` |

---

### Task 1: PATH Caching in `fix_path_env()`

**Files:**
- Modify: `src-tauri/src/lib.rs:21-73`

- [ ] **Step 1: Add PATH cache read logic**

At the top of `fix_path_env()`, before the shell spawn, try to read the cached PATH. The cache file is `~/.teamclaw/cached-path.txt` with format `<shell_profile_mtime>\n<path_value>`. If the cache exists and the mtime matches the current shell profile's mtime, use the cached PATH and return early.

```rust
fn fix_path_env() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            "cmd".to_string()
        } else {
            "/bin/zsh".to_string()
        }
    });

    if cfg!(target_os = "windows") {
        return;
    }

    // Try cache first
    let home = std::env::var("HOME").unwrap_or_default();
    let cache_path = std::path::PathBuf::from(&home).join(".teamclaw").join("cached-path.txt");
    let profile_mtime = get_shell_profile_mtime(&shell, &home);

    if let Some(cached) = read_path_cache(&cache_path, profile_mtime) {
        std::env::set_var("PATH", &cached);
        #[cfg(debug_assertions)]
        eprintln!("[fix_path_env] PATH set from cache");
        return;
    }

    // Spawn login shell (existing logic)
    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", "echo $PATH"])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let full_path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !full_path.is_empty() {
                std::env::set_var("PATH", &full_path);
                // Write cache (fire-and-forget)
                write_path_cache(&cache_path, profile_mtime, &full_path);
                #[cfg(debug_assertions)]
                eprintln!("[fix_path_env] PATH set to: {}", &full_path);
            }
        }
        _ => {
            // Existing fallback logic (unchanged)
            let current = std::env::var("PATH").unwrap_or_default();
            let extra = [
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/usr/local/sbin",
                "/home/linuxbrew/.linuxbrew/bin",
            ];
            let mut path = current.clone();
            for p in extra {
                if !path.split(':').any(|seg| seg == p) {
                    path = format!("{}:{}", p, path);
                }
            }
            if path != current {
                std::env::set_var("PATH", &path);
                #[cfg(debug_assertions)]
                eprintln!("[fix_path_env] PATH fallback set to: {}", &path);
            }
        }
    }
}
```

- [ ] **Step 2: Add helper functions for cache read/write**

Add these helper functions above `fix_path_env()` in `lib.rs`:

```rust
/// Get the mtime of the user's shell profile file as a u64 (seconds since epoch).
/// Returns 0 if the file doesn't exist or can't be read.
fn get_shell_profile_mtime(shell: &str, home: &str) -> u64 {
    let profile = if shell.ends_with("zsh") {
        format!("{}/.zshrc", home)
    } else if shell.ends_with("bash") {
        format!("{}/.bashrc", home)
    } else {
        return 0;
    };
    std::fs::metadata(&profile)
        .and_then(|m| m.modified())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)))
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read cached PATH if cache exists and profile mtime matches.
fn read_path_cache(cache_path: &std::path::Path, current_mtime: u64) -> Option<String> {
    let content = std::fs::read_to_string(cache_path).ok()?;
    let mut lines = content.lines();
    let cached_mtime: u64 = lines.next()?.parse().ok()?;
    if cached_mtime != current_mtime || current_mtime == 0 {
        return None;
    }
    let path = lines.next()?;
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

/// Write PATH cache file. Creates ~/.teamclaw/ if needed.
fn write_path_cache(cache_path: &std::path::Path, mtime: u64, path: &str) {
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let content = format!("{}\n{}", mtime, path);
    let _ = std::fs::write(cache_path, content);
}
```

- [ ] **Step 3: Build and verify**

Run: `cd /Users/matt.chow/workspace/teamclaw && cargo build -p teamclaw 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Manual test — cache miss then cache hit**

1. Delete cache: `rm -f ~/.teamclaw/cached-path.txt`
2. Run the app. Observe `[fix_path_env] PATH set to:` in debug log (shell was spawned).
3. Check cache was created: `cat ~/.teamclaw/cached-path.txt`
4. Restart the app. Observe `[fix_path_env] PATH set from cache` (no shell spawn).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "perf: cache fix_path_env() PATH result to avoid shell spawn on restart"
```

---

### Task 2: Parallel File I/O Before Sidecar Spawn

**Files:**
- Modify: `src-tauri/src/commands/opencode.rs:273-349`

- [ ] **Step 1: Refactor pre-sidecar operations into parallel groups**

Replace the sequential block at lines 273-349 with parallel execution. The three `opencode.json` writers stay sequential in one branch, while `ensure_inherent_skills` and `read_keyring_secrets` run in parallel branches.

Replace lines 273-349 of `opencode.rs` (from `// Ensure opencode.json has a permission section` to `let original_config = resolve_config_secret_refs(...)`) with:

```rust
    // ── Pre-sidecar setup (parallelized) ──────────────────────────────
    //
    // Three branches run concurrently via tokio::join!:
    //   1. opencode.json writers (sequential: permissions → config → binary paths)
    //   2. ensure_inherent_skills (writes to .opencode/skills/, independent)
    //   3. read_keyring_secrets (reads OS keyring, independent)
    //
    // resolve_config_secret_refs runs AFTER all three complete (depends on
    // both the config writers finishing and keyring secrets being available).

    let ws_for_config = workspace_path.clone();
    let ws_for_skills = workspace_path.clone();
    let ws_for_keyring = workspace_path.clone();

    let (config_result, skills_result, keyring_result) = tokio::join!(
        // Branch 1: opencode.json writers (must be sequential with each other)
        tokio::task::spawn_blocking(move || {
            if let Err(e) = ensure_default_permissions(&ws_for_config) {
                eprintln!("[OpenCode] Warning: failed to ensure default permissions: {}", e);
            }
            if let Err(e) = ensure_inherent_config(&ws_for_config) {
                eprintln!("[OpenCode] Warning: failed to ensure inherent configs: {}", e);
            }
            if let Err(e) = resolve_sidecar_binary_paths(&ws_for_config) {
                eprintln!("[OpenCode] Warning: failed to resolve binary paths: {}", e);
            }
        }),
        // Branch 2: inherent skills (writes to .opencode/skills/, no opencode.json conflict)
        tokio::task::spawn_blocking(move || {
            if let Err(e) = ensure_inherent_skills(&ws_for_skills) {
                eprintln!("[OpenCode] Warning: failed to ensure inherent skills: {}", e);
            }
        }),
        // Branch 3: keyring secrets
        tokio::task::spawn_blocking(move || read_keyring_secrets(&ws_for_keyring))
    );

    // Unwrap spawn results (panics inside spawn_blocking become JoinErrors)
    if let Err(e) = config_result {
        eprintln!("[OpenCode] Config setup task panicked: {}", e);
    }
    if let Err(e) = skills_result {
        eprintln!("[OpenCode] Skills setup task panicked: {}", e);
    }

    let (mut secrets, failed_keys) = keyring_result.unwrap_or_else(|e| {
        eprintln!("[OpenCode] spawn_blocking for keyring failed: {}", e);
        (Vec::new(), Vec::new())
    });

    // Keyring retry logic (unchanged)
    if !failed_keys.is_empty() {
        println!(
            "[OpenCode] {} secret(s) failed to read ({:?}), retrying after keychain unlock...",
            failed_keys.len(),
            failed_keys
        );
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        let ws_retry = workspace_path.clone();
        let (retry_secrets, still_failed) =
            tokio::task::spawn_blocking(move || read_keyring_secrets(&ws_retry))
                .await
                .unwrap_or_else(|e| {
                    eprintln!("[OpenCode] spawn_blocking for keyring retry failed: {}", e);
                    (Vec::new(), Vec::new())
                });

        if !still_failed.is_empty() {
            eprintln!(
                "[OpenCode] Warning: {} secret(s) still unavailable after retry: {:?}",
                still_failed.len(),
                still_failed
            );
        }

        secrets = retry_secrets;
    }

    let original_config = resolve_config_secret_refs(&workspace_path, &secrets);
```

- [ ] **Step 2: Build and verify**

Run: `cd /Users/matt.chow/workspace/teamclaw && cargo build -p teamclaw 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Manual test — start app, verify sidecar starts normally**

Start the app, select a workspace. Verify:
- OpenCode sidecar starts and becomes ready
- No errors in the terminal log
- Chat is functional

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/opencode.rs
git commit -m "perf: parallelize pre-sidecar file I/O with tokio::join!"
```

---

### Task 3: Early Sidecar Launch — State and Persistence

**Files:**
- Modify: `src-tauri/src/commands/opencode.rs:14-55` (OpenCodeState struct)

- [ ] **Step 1: Add EarlyLaunchState and extend OpenCodeState**

Add an `EarlyLaunchState` struct and a field to `OpenCodeState` to hold the early launch result. Add this right after the existing `OpenCodeState` struct definition:

```rust
/// State for the early sidecar launch (initiated from setup hook before frontend).
pub struct EarlyLaunchState {
    /// The workspace path this early launch was started for.
    pub workspace_path: String,
    /// Receiver to await the result. Clone to subscribe.
    pub result_rx: tokio::sync::watch::Receiver<Option<Result<OpenCodeStatus, String>>>,
}
```

Add this field to `OpenCodeState`:

```rust
    /// Early launch state — set by setup hook, consumed by start_opencode.
    pub early_launch: tokio::sync::Mutex<Option<EarlyLaunchState>>,
```

And initialize it in the `Default` impl:

```rust
    early_launch: tokio::sync::Mutex::new(None),
```

- [ ] **Step 2: Add workspace path persistence helpers**

Add these functions at the bottom of `opencode.rs` (before the tests, if any):

```rust
/// Path to the file that persists the last workspace for early launch.
fn last_workspace_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".teamclaw").join("last-workspace.json")
}

/// Read the last workspace path from ~/.teamclaw/last-workspace.json.
pub fn read_last_workspace() -> Option<String> {
    let path = last_workspace_path();
    let content = std::fs::read_to_string(&path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let ws = json.get("workspace_path")?.as_str()?;
    // Verify the directory still exists
    if std::path::Path::new(ws).is_dir() {
        Some(ws.to_string())
    } else {
        #[cfg(debug_assertions)]
        eprintln!("[EarlyLaunch] Last workspace '{}' no longer exists, skipping", ws);
        None
    }
}

/// Persist the workspace path for next launch.
fn write_last_workspace(workspace_path: &str) {
    let path = last_workspace_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::json!({ "workspace_path": workspace_path });
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap_or_default());
}
```

- [ ] **Step 3: Write workspace path after successful start**

In the `start_opencode` function, after the final state update block (around line 455-463, the block that sets `is_running`, `port`, and `workspace_path`), add:

```rust
    // Persist workspace for early launch on next startup
    write_last_workspace(&workspace_path);
```

- [ ] **Step 4: Build and verify**

Run: `cd /Users/matt.chow/workspace/teamclaw && cargo build -p teamclaw 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/opencode.rs
git commit -m "feat: add EarlyLaunchState and workspace path persistence"
```

---

### Task 4: Early Sidecar Launch — Setup Hook Integration

**Files:**
- Modify: `src-tauri/src/lib.rs:354-667` (setup hook)
- Modify: `src-tauri/src/commands/opencode.rs:59-472` (start_opencode)

- [ ] **Step 1: Add early launch trigger in setup hook**

In `lib.rs`, inside the `setup` closure (after the P2P initialization block, around line 381, before the `// --- System Tray ---` comment), add:

```rust
            // --- Early sidecar launch ---
            // Read last workspace and start OpenCode before frontend renders.
            // The frontend's start_opencode call will reuse this result if the path matches.
            if std::env::var("TEAMCLAW_DISABLE_EARLY_LAUNCH").unwrap_or_default() != "1" {
                if let Some(workspace_path) = commands::opencode::read_last_workspace() {
                    println!("[EarlyLaunch] Starting sidecar for: {}", workspace_path);
                    let app_handle = app.handle().clone();
                    let (tx, rx) = tokio::sync::watch::channel(None);

                    // Store the early launch state so start_opencode can find it
                    let early_state = app_handle.state::<commands::opencode::OpenCodeState>();
                    {
                        let mut early = early_state.early_launch.blocking_lock();
                        *early = Some(commands::opencode::EarlyLaunchState {
                            workspace_path: workspace_path.clone(),
                            result_rx: rx,
                        });
                    }

                    tauri::async_runtime::spawn(async move {
                        let state = app_handle.state::<commands::opencode::OpenCodeState>();
                        let config = commands::opencode::OpenCodeConfig {
                            workspace_path,
                            port: None,
                        };
                        let result = commands::opencode::start_opencode_inner(
                            app_handle.clone(),
                            &state,
                            config,
                        ).await;
                        let _ = tx.send(Some(result));
                    });
                }
            }
```

- [ ] **Step 2: Extract `start_opencode_inner` from `start_opencode`**

In `opencode.rs`, create a new `pub async fn start_opencode_inner` by moving the **entire body** of the current `start_opencode` function (lines 64-471, from `let _start_guard = state.start_lock.lock().await;` through the final `Ok(OpenCodeStatus { ... })`) into it.

Key signature change: `state` parameter changes from `State<'_, OpenCodeState>` (Tauri managed state wrapper) to `&OpenCodeState` (plain reference), since `start_opencode_inner` is not a Tauri command. `State` auto-derefs to the inner type, so all existing `state.xxx` usage works unchanged.

Note on `start_lock`: `start_opencode_inner` retains the `start_lock` acquisition at the top. This means if the early launch is still running when a frontend mismatch/fallback triggers `start_opencode_inner`, the fallback will block on the lock until the early launch completes — this is correct behavior.

```rust
/// Core sidecar startup logic, shared between the Tauri command and early launch.
///
/// Acquires `start_lock` internally to serialize concurrent calls.
pub async fn start_opencode_inner(
    app: AppHandle,
    state: &OpenCodeState,
    config: OpenCodeConfig,
) -> Result<OpenCodeStatus, String> {
    // Serialize concurrent calls — only one start_opencode runs at a time.
    let _start_guard = state.start_lock.lock().await;

    // ... rest is the ENTIRE existing body of start_opencode from line 66
    // (let is_dev_mode = ...) through line 471 (the final Ok(OpenCodeStatus { ... })),
    // copied verbatim. No changes needed to the body — all `state.xxx` calls
    // work because State<'_, T> derefs to &T.
}
```

- [ ] **Step 3: Write the new `start_opencode` wrapper with early launch check**

Replace the existing `start_opencode` function with a thin wrapper:

```rust
/// Start OpenCode server as a sidecar process (or connect to external in dev mode)
#[tauri::command]
pub async fn start_opencode(
    app: AppHandle,
    state: State<'_, OpenCodeState>,
    config: OpenCodeConfig,
) -> Result<OpenCodeStatus, String> {
    // Check if early launch is in progress for this workspace
    {
        let mut early_guard = state.early_launch.lock().await;
        if let Some(early) = early_guard.as_ref() {
            if early.workspace_path == config.workspace_path {
                println!("[OpenCode] Reusing early launch for: {}", config.workspace_path);
                let mut rx = early.result_rx.clone();
                // Drop the lock before awaiting
                drop(early_guard);
                // Wait for the early launch to complete
                while rx.borrow().is_none() {
                    if rx.changed().await.is_err() {
                        break;
                    }
                }
                let result = rx.borrow().clone();
                // Clear early launch state
                let mut early_guard = state.early_launch.lock().await;
                *early_guard = None;
                match result {
                    Some(Ok(status)) => return Ok(status),
                    Some(Err(e)) => {
                        // Early launch failed — fall through to fresh attempt
                        println!("[OpenCode] Early launch failed ({}), retrying fresh", e);
                    }
                    None => {
                        // Sender dropped without result — fall through
                        println!("[OpenCode] Early launch sender dropped, retrying fresh");
                    }
                }
            } else {
                // Different workspace — clear early launch, proceed normally
                println!("[OpenCode] Workspace mismatch, clearing early launch");
                *early_guard = None;
            }
        }
    }

    start_opencode_inner(app, &state, config).await
}
```

- [ ] **Step 4: Build and verify**

Run: `cd /Users/matt.chow/workspace/teamclaw && cargo build -p teamclaw 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 5: Manual test — early launch flow**

1. Start the app with a workspace. Wait for it to be ready. Quit.
2. Check `~/.teamclaw/last-workspace.json` exists with correct path.
3. Restart the app. Observe in logs:
   - `[EarlyLaunch] Starting sidecar for: /path/to/workspace`
   - `[OpenCode] Reusing early launch for: /path/to/workspace`
4. Verify app starts faster (sidecar was already starting during React render).

- [ ] **Step 6: Manual test — early launch disabled**

Run: `TEAMCLAW_DISABLE_EARLY_LAUNCH=1 cargo tauri dev`
Verify the app starts normally without the early launch log messages.

- [ ] **Step 7: Manual test — workspace mismatch**

1. Start app with workspace A. Quit.
2. Edit `~/.teamclaw/last-workspace.json` to point to workspace B.
3. Start app, select workspace A from prompt.
4. Verify `[OpenCode] Workspace mismatch, clearing early launch` in logs.
5. Verify workspace A loads correctly.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands/opencode.rs
git commit -m "perf: early sidecar launch from Rust setup hook"
```

---

### Task 5: Remove Frontend 300ms Delay

**Files:**
- Modify: `packages/app/src/hooks/useAppInit.ts:58-109`

- [ ] **Step 1: Simplify useOpenCodeInit**

Replace the setTimeout-based launch with a direct call. Replace lines 74-108 (from `const alreadyPreloading` to the end of the useEffect return) with:

```typescript
    const alreadyPreloading = hasPreloadFor(workspacePath);
    if (!alreadyPreloading) {
      setOpenCodeReady(false);
    }

    let cancelled = false;

    console.log(
      alreadyPreloading
        ? "[OpenCode] Awaiting preloaded server for:"
        : "[OpenCode] Starting server for:",
      workspacePath,
    );
    startOpenCode(workspacePath)
      .then((status) => {
        if (cancelled) return;
        console.log("[OpenCode] Server started:", status);
        initOpenCodeClient({ baseUrl: status.url, workspacePath });
        setOpenCodeError(null);
        setOpenCodeReady(true, status.url);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("[OpenCode] Failed to start server:", error);
        setOpenCodeError(String(error));
      });

    return () => {
      cancelled = true;
    };
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd /Users/matt.chow/workspace/teamclaw && pnpm --filter app build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/hooks/useAppInit.ts
git commit -m "perf: remove unnecessary 300ms delay in useOpenCodeInit"
```

---

### Task 6: Defer Dependency Check

**Files:**
- Modify: `packages/app/src/hooks/useAppInit.ts:286-361` (useSetupGuide)
- Modify: `packages/app/src/App.tsx:919`

- [ ] **Step 1: Add `openCodeReady` parameter to `useSetupGuide`**

Change the `useSetupGuide` function signature and defer the dependency check:

```typescript
export function useSetupGuide(openCodeReady: boolean) {
```

Then modify the mount useEffect (around line 300) to only run when `openCodeReady` is true. Change:

```typescript
  // Preload + dependency check on mount
  useEffect(() => {
    const debugForceSetup = (() => {
      try {
        return localStorage.getItem("teamclaw-debug-force-setup") === "1";
      } catch {
        return false;
      }
    })();

    if (!isTauri() && !debugForceSetup) return;

    const decision = setupDecisionRef.current;

    if (decision === "skip") {
      console.log("[Preload] Setup previously completed, skipping dep check");
      depsResultRef.current = { checked: true, hasRequiredMissing: false };
      return;
    }

    console.log("[Preload] Checking dependencies (decision:", decision, ")");
    checkDependencies().then((result) => {
      const hasRequiredMissing = result.some((d) => d.required && !d.installed);
      depsResultRef.current = { checked: true, hasRequiredMissing };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

To:

```typescript
  // Dependency check — deferred until OpenCode is ready to avoid CPU contention
  useEffect(() => {
    const debugForceSetup = (() => {
      try {
        return localStorage.getItem("teamclaw-debug-force-setup") === "1";
      } catch {
        return false;
      }
    })();

    if (!isTauri() && !debugForceSetup) return;

    const decision = setupDecisionRef.current;

    if (decision === "skip") {
      depsResultRef.current = { checked: true, hasRequiredMissing: false };
      return;
    }

    // Wait for OpenCode to be ready before checking deps (reduces startup CPU contention)
    if (!openCodeReady && isTauri()) return;

    console.log("[Setup] Checking dependencies (decision:", decision, ")");
    checkDependencies().then((result) => {
      const hasRequiredMissing = result.some((d) => d.required && !d.installed);
      depsResultRef.current = { checked: true, hasRequiredMissing };
    });
  }, [openCodeReady, checkDependencies]);
```

- [ ] **Step 2: Update call site in App.tsx**

In `App.tsx`, line 919, change:

```typescript
  const { showSetupGuide, dependencies, handleRecheck, handleSetupContinue } = useSetupGuide();
```

To:

```typescript
  const openCodeReady = useWorkspaceStore((s) => s.openCodeReady);
  const { showSetupGuide, dependencies, handleRecheck, handleSetupContinue } = useSetupGuide(openCodeReady);
```

Note: `useWorkspaceStore` is already imported in `App.tsx` (line 70). The `openCodeReady` selector is already used in `AppContent` (line 414), but `App` function needs its own subscription since hooks can't be shared across components.

- [ ] **Step 3: Verify frontend builds**

Run: `cd /Users/matt.chow/workspace/teamclaw && pnpm --filter app build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Manual test — dependency check timing**

1. Clear setup flag: `localStorage.removeItem('teamclaw-setup-completed')` in devtools
2. Start app with a workspace
3. Observe that dependency check logs appear AFTER `[OpenCode] Server started` in console
4. Setup guide should still appear if required deps are missing

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/hooks/useAppInit.ts packages/app/src/App.tsx
git commit -m "perf: defer dependency check until after OpenCode is ready"
```

---

### Task 7: Final Verification and Cleanup

**Files:**
- All modified files

- [ ] **Step 1: Full build check (Rust + Frontend)**

Run: `cd /Users/matt.chow/workspace/teamclaw && cargo build -p teamclaw && pnpm --filter app build`
Expected: Both succeed

- [ ] **Step 2: Test all startup scenarios**

Test each scenario manually:

1. **Fresh install**: Delete `~/.teamclaw/last-workspace.json` and `~/.teamclaw/cached-path.txt`. Start app. Verify workspace prompt appears, then sidecar starts after selecting a workspace.

2. **Normal restart**: Quit and restart. Verify early launch kicks in and app starts faster.

3. **Workspace switch**: Start app, go to settings, switch workspace. Verify the new workspace loads correctly.

4. **Deleted workspace**: Edit `last-workspace.json` to point to a non-existent path. Start app. Verify fallback to frontend-triggered flow (no crash).

5. **Dev mode**: Set `OPENCODE_DEV_MODE=true`. Start app. Verify dev mode still works.

6. **Early launch disabled**: Set `TEAMCLAW_DISABLE_EARLY_LAUNCH=1`. Verify normal startup flow.

- [ ] **Step 3: Commit any fixups**

If any issues found, fix and commit with descriptive messages.
