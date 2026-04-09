# Startup Acceleration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce warm startup time from ~3.3s to ≤2s by deferring resource-competing tasks and eliminating white screen.

**Architecture:** Two parallel strategies — (A) defer non-critical Tauri invokes until sidecar is ready to eliminate I/O contention, (B) add inline skeleton screen + split JS bundle to eliminate white screen and reduce parse time.

**Tech Stack:** React 19, Zustand, Vite/Rollup, Tauri 2.0 (Rust), HTML/CSS

**Spec:** `docs/superpowers/specs/2026-04-08-startup-acceleration-design.md`

---

### Task 1: Defer `useOssSyncInit` until sidecar ready

This is the highest-impact change. `oss_restore_sync` competes with sidecar startup for CPU/IO, inflating startup from ~1.8s to ~3.3s.

**Files:**
- Modify: `packages/app/src/hooks/useAppInit.ts:534-551`

- [ ] **Step 1: Add openCodeReady guard to useOssSyncInit**

In `packages/app/src/hooks/useAppInit.ts`, modify the `useOssSyncInit` function:

```typescript
export function useOssSyncInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openCodeReady = useWorkspaceStore((s) => s.openCodeReady);
  const initialize = useTeamOssStore((s) => s.initialize);
  const cleanup = useTeamOssStore((s) => s.cleanup);

  useEffect(() => {
    if (!workspacePath || !openCodeReady || !isTauri()) return;

    // Clean up previous workspace listener, reset state, then re-initialize
    cleanup();
    initialize(workspacePath).catch((err: unknown) => {
      console.warn("[App] OSS sync init failed (non-critical):", err);
    });

    return () => {
      cleanup();
    };
  }, [workspacePath, openCodeReady, initialize, cleanup]);
}
```

Changes from current code:
- Add `const openCodeReady = useWorkspaceStore((s) => s.openCodeReady);`
- Add `!openCodeReady` to the guard condition
- Add `openCodeReady` to the dependency array

- [ ] **Step 2: Run typecheck**

Run: `cd packages/app && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Run unit tests**

Run: `pnpm test:unit`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/hooks/useAppInit.ts
git commit -m "perf(startup): defer OssSyncInit until sidecar ready

OssRestore was competing with sidecar for I/O/CPU during startup,
inflating sidecar boot from ~1.8s to ~3.3s. Now waits for openCodeReady."
```

---

### Task 2: Defer team sync in `useGitReposInit` until sidecar ready

The `team_sync_repo` invoke does a network git pull at startup, adding unnecessary I/O contention.

**Files:**
- Modify: `packages/app/src/hooks/useAppInit.ts:349-432`

- [ ] **Step 1: Split useGitReposInit to defer team sync**

The function currently fires both local git init and team sync together. Separate the team sync into a guarded block that waits for `openCodeReady`. Replace the entire `useGitReposInit` function:

```typescript
export function useGitReposInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openCodeReady = useWorkspaceStore((s) => s.openCodeReady);
  const { initialize: initGitRepos, syncAll: syncGitRepos } = useGitReposStore();
  const hasGitSynced = useRef(false);
  const teamSyncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Local git repos init — runs immediately when workspace is set
  useEffect(() => {
    if (workspacePath && !hasGitSynced.current) {
      hasGitSynced.current = true;

      initGitRepos()
        .then(() => {
          syncGitRepos().catch((err: unknown) => {
            console.warn("[App] Git auto-sync failed (non-critical):", err);
          });
        })
        .catch((err: unknown) => {
          console.warn("[App] Git repos init failed (non-critical):", err);
        });
    }
  }, [workspacePath, initGitRepos, syncGitRepos]);

  // Team sync — deferred until sidecar is ready to avoid I/O contention
  useEffect(() => {
    if (!workspacePath || !openCodeReady || !isTauri()) return;

    import("@tauri-apps/api/core")
      .then(({ invoke }) => {
        invoke("get_team_config")
          .then((config: unknown) => {
            const teamConfig = config as { enabled?: boolean } | null;
            if (teamConfig?.enabled) {
              const doSync = () => {
                invoke("team_sync_repo")
                  .then((result: unknown) => {
                    const r = result as { success: boolean; message: string };
                    if (r.success) {
                      console.log("[App] Team repo sync completed (MCP configs updated)");
                    } else {
                      console.warn("[App] Team repo sync skipped:", r.message);
                    }
                  })
                  .catch((err: unknown) => {
                    console.warn("[App] Team repo sync failed (non-critical):", err);
                  });
              };

              console.log("[App] Team config found, syncing team repo...");
              doSync();

              // Periodic sync every 5 minutes
              const intervalId = setInterval(() => {
                console.log("[App] Periodic team repo sync...");
                doSync();
              }, 5 * 60 * 1000);
              teamSyncIntervalRef.current = intervalId;
            }
          })
          .catch((err: unknown) => {
            console.warn("[App] Failed to check team config (non-critical):", err);
          });
      })
      .catch(() => {
        // Tauri not available, skip
      });

    // Load team shortcuts after team config
    import("@/lib/team-shortcuts")
      .then(({ loadTeamShortcutsFile }) => {
        return loadTeamShortcutsFile(workspacePath);
      })
      .then((teamShortcuts) => {
        useShortcutsStore.getState().setTeamNodes(teamShortcuts || []);
      })
      .catch((err: unknown) => {
        console.warn("[App] Failed to load team shortcuts (non-critical):", err);
      });

    return () => {
      if (teamSyncIntervalRef.current) {
        clearInterval(teamSyncIntervalRef.current);
        teamSyncIntervalRef.current = null;
      }
    };
  }, [workspacePath, openCodeReady]);
}
```

Key changes:
- Split into two `useEffect` hooks
- First effect: local git init (runs immediately, no sidecar needed)
- Second effect: team sync + team shortcuts (deferred until `openCodeReady`)
- Added `openCodeReady` to state reads and dependency array of second effect

- [ ] **Step 2: Run typecheck**

Run: `cd packages/app && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Run unit tests**

Run: `pnpm test:unit`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/hooks/useAppInit.ts
git commit -m "perf(startup): defer team sync until sidecar ready

Split useGitReposInit into two effects: local git init runs immediately,
team_sync_repo and team shortcuts deferred until openCodeReady."
```

---

### Task 3: Inline skeleton screen in index.html

Eliminate the white screen by showing a CSS-only skeleton that mimics the app layout. Visible the instant WebView renders HTML — before any JS executes.

**Files:**
- Modify: `packages/app/index.html`
- Modify: `packages/app/src/main.tsx`

- [ ] **Step 1: Add skeleton and theme script to index.html**

Replace the contents of `packages/app/index.html` with:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TeamClaw</title>
    <style>
      /* Skeleton — removed by React on mount */
      #skeleton {
        display: flex;
        height: 100vh;
        font-family: system-ui, -apple-system, sans-serif;
      }
      #skeleton .sidebar {
        width: 320px;
        border-right: 1px solid var(--sk-border);
        padding: 16px;
        flex-shrink: 0;
      }
      #skeleton .main {
        flex: 1;
        padding: 16px;
      }
      #skeleton .bone {
        background: var(--sk-bone);
        border-radius: 6px;
        margin-bottom: 10px;
      }
      /* Light theme (default) */
      :root {
        --sk-bg: #ffffff;
        --sk-border: #e4e4e7;
        --sk-bone: #f4f4f5;
      }
      /* Dark theme */
      .dark {
        --sk-bg: #09090b;
        --sk-border: #27272a;
        --sk-bone: #18181b;
      }
      #skeleton { background: var(--sk-bg); }
    </style>
    <script>
      // Apply theme before first paint (matches main.tsx logic)
      (function() {
        var sn = 'teamclaw';
        try {
          var k = localStorage.getItem(sn + '-shortname');
          if (k) sn = k;
        } catch(e) {}
        var theme;
        try { theme = localStorage.getItem(sn + '-theme'); } catch(e) {}
        if (!theme) theme = 'system';
        if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
          document.documentElement.classList.add('dark');
        }
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <div id="skeleton">
      <div class="sidebar">
        <div class="bone" style="height:20px;width:55%"></div>
        <div class="bone" style="height:14px;width:80%;margin-top:20px"></div>
        <div class="bone" style="height:14px;width:65%"></div>
        <div class="bone" style="height:14px;width:75%"></div>
        <div class="bone" style="height:14px;width:60%"></div>
      </div>
      <div class="main">
        <div class="bone" style="height:24px;width:35%"></div>
        <div class="bone" style="height:14px;width:50%;margin-top:24px"></div>
      </div>
    </div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Key design decisions:
- Uses CSS custom properties for theme support (light/dark)
- Inline `<script>` reads `${appShortName}-theme` from localStorage (same logic as `main.tsx` line 21)
- Skeleton layout matches actual app: 320px sidebar + flex-1 main area
- No animations to avoid CPU usage during critical startup path

- [ ] **Step 2: Remove skeleton on React mount in main.tsx**

In `packages/app/src/main.tsx`, add skeleton removal right before `createRoot`:

```typescript
// Remove skeleton screen (shown by index.html before JS loads)
document.getElementById('skeleton')?.remove();

createRoot(document.getElementById('root')!).render(
```

- [ ] **Step 3: Verify visually in dev mode**

Run: `pnpm dev`
Expected: On page load, skeleton flashes briefly then app renders. No white screen.

- [ ] **Step 4: Verify dark theme**

In browser devtools console: `localStorage.setItem('teamclaw-theme', 'dark')`, reload.
Expected: Skeleton shows with dark background (#09090b), no white flash.

- [ ] **Step 5: Commit**

```bash
git add packages/app/index.html packages/app/src/main.tsx
git commit -m "perf(startup): add inline skeleton screen to eliminate white screen

Pure CSS/HTML skeleton in index.html visible before any JS executes.
Matches sidebar + main layout. Theme-aware via localStorage read.
Removed by React on mount."
```

---

### Task 4: Split main JS bundle via Vite manualChunks

The main `index-*.js` is 2.4MB. Add chunk splitting for Tauri APIs and i18n to reduce initial parse time.

**Files:**
- Modify: `packages/app/vite.config.ts:126-144`

- [ ] **Step 1: Measure current bundle**

Run: `cd packages/app && ANALYZE=true pnpm build`
Expected: Opens bundle analysis in browser. Note the size of `index-*.js`. Save screenshot or note.

- [ ] **Step 2: Add manualChunks for Tauri and i18n**

In `packages/app/vite.config.ts`, update the `manualChunks` config:

```typescript
manualChunks: {
  // React runtime - stable, long-cache
  'react-vendor': ['react', 'react-dom'],
  // Radix UI primitives
  'radix': [
    '@radix-ui/react-dialog',
    '@radix-ui/react-dropdown-menu',
    '@radix-ui/react-popover',
    '@radix-ui/react-scroll-area',
    '@radix-ui/react-select',
    '@radix-ui/react-tooltip',
    '@radix-ui/react-collapsible',
    '@radix-ui/react-avatar',
    '@radix-ui/react-separator',
    '@radix-ui/react-slot',
  ],
  // Markdown rendering
  'markdown': ['react-markdown', 'remark-gfm'],
  // Tauri APIs — loaded async, not needed for skeleton
  'tauri': [
    '@tauri-apps/api',
    '@tauri-apps/plugin-fs',
    '@tauri-apps/plugin-shell',
    '@tauri-apps/plugin-dialog',
    '@tauri-apps/plugin-notification',
    '@tauri-apps/plugin-process',
  ],
  // i18n runtime
  'i18n': ['i18next', 'react-i18next'],
},
```

Changes from current: added `'tauri'` and `'i18n'` entries.

- [ ] **Step 3: Build and measure new bundle**

Run: `cd packages/app && ANALYZE=true pnpm build`
Expected: `index-*.js` smaller than before. Check the new chunk sizes — `tauri-*.js` and `i18n-*.js` should appear.

- [ ] **Step 4: Verify the build runs**

Run: `pnpm build`
Expected: Build succeeds with no errors.

- [ ] **Step 5: Compare sizes**

Run: `ls -lhS packages/app/dist/assets/index-*.js packages/app/dist/assets/tauri-*.js packages/app/dist/assets/i18n-*.js packages/app/dist/assets/react-vendor-*.js`
Expected: `index-*.js` noticeably smaller than the previous 2.4MB.

- [ ] **Step 6: Commit**

```bash
git add packages/app/vite.config.ts
git commit -m "perf(startup): split Tauri API and i18n into separate chunks

Reduces main index chunk size by extracting @tauri-apps/* and i18next
into their own lazy-loaded chunks, cutting initial JS parse time."
```

---

### Task 5: Add startup timing instrumentation

Add performance markers in both Rust (release builds) and frontend to measure and log startup phases.

**Files:**
- Modify: `src-tauri/src/lib.rs:170-180, 559-613`
- Modify: `src-tauri/src/commands/opencode.rs:131-138, 512-515, 691-694`
- Modify: `packages/app/src/main.tsx`
- Modify: `packages/app/src/hooks/useAppInit.ts:41-142`

- [ ] **Step 1: Enable Rust startup timing in release builds (lib.rs)**

In `src-tauri/src/lib.rs`, change the timing markers from debug-only to always-on. Replace lines 170-180:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_t0 = std::time::Instant::now();

    // Fix PATH before anything else so all child processes can find tools
    fix_path_env();
    eprintln!(
        "[Startup] fix_path_env: {:.1}ms",
        startup_t0.elapsed().as_secs_f64() * 1000.0
    );
```

Remove the `#[cfg(debug_assertions)]` from `startup_t0` (line 171-172) and the eprintln (lines 176-180).

Similarly in the setup hook, replace lines 559-561:

```rust
        .setup(|app| {
            let setup_t0 = std::time::Instant::now();
```

Remove `#[cfg(debug_assertions)]` from `setup_t0` (line 560-561).

And replace lines 612-613:

```rust
            eprintln!("[Startup] Setup hook (before early launch): {:.1}ms", setup_t0.elapsed().as_secs_f64() * 1000.0);
```

Remove the `#[cfg(debug_assertions)]` from this eprintln (line 612).

- [ ] **Step 2: Enable Rust startup timing in release builds (opencode.rs)**

In `src-tauri/src/commands/opencode.rs`, remove `#[cfg(debug_assertions)]` from:

Line 131-132 — `inner_t0` declaration:
```rust
    let inner_t0 = std::time::Instant::now();
```

Line 135-138 — lock acquired log:
```rust
    eprintln!(
        "[Startup] start_opencode_inner: lock acquired in {:.1}ms",
        inner_t0.elapsed().as_secs_f64() * 1000.0
    );
```

Line 512-515 — pre-sidecar I/O log:
```rust
    eprintln!(
        "[Startup] Pre-sidecar I/O (parallel): {:.1}ms",
        inner_t0.elapsed().as_secs_f64() * 1000.0
    );
```

Line 691-694 — total log:
```rust
    eprintln!(
        "[Startup] start_opencode_inner TOTAL: {:.1}ms",
        inner_t0.elapsed().as_secs_f64() * 1000.0
    );
```

- [ ] **Step 3: Add frontend timing marks in main.tsx**

In `packages/app/src/main.tsx`, add a mark right before createRoot (after skeleton removal):

```typescript
// Remove skeleton screen (shown by index.html before JS loads)
document.getElementById('skeleton')?.remove();
performance.mark('react-mount');

createRoot(document.getElementById('root')!).render(
```

- [ ] **Step 4: Add frontend timing marks in useAppInit.ts**

In `packages/app/src/hooks/useAppInit.ts`, inside `useOpenCodeInit`:

After `setInitialWorkspaceResolved(true)` (line 82), add:
```typescript
        performance.mark('workspace-restored');
```

After `setOpenCodeReady(true, status.url)` (line 131), add:
```typescript
        performance.mark('opencode-ready');
        if (performance.getEntriesByName('react-mount').length) {
          performance.measure('startup-total', 'react-mount', 'opencode-ready');
          const total = performance.getEntriesByName('startup-total')[0];
          console.log(`[Startup] react→ready: ${Math.round(total.duration)}ms`);
        }
```

- [ ] **Step 5: Verify timing output**

Run: `pnpm dev`, open app, check browser console.
Expected: See `[Startup] react→ready: Xms` log in console.

Run Rust in debug: check stderr for `[Startup]` lines with timings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands/opencode.rs packages/app/src/main.tsx packages/app/src/hooks/useAppInit.ts
git commit -m "perf(startup): add timing instrumentation for release builds

Enable [Startup] timing markers in Rust release builds.
Add performance.mark/measure in frontend for react-mount → opencode-ready.
Logs startup duration to console and stderr."
```

---

### Task 6: Verify full startup improvement

Run the complete release build and measure the improvement.

**Files:**
- No file changes — verification only

- [ ] **Step 1: Build release app**

Run: `pnpm tauri:build`
Expected: Build succeeds.

- [ ] **Step 2: Kill existing instances**

Run: `pkill -f "TeamClaw" 2>/dev/null; pkill -f "teamclaw" 2>/dev/null; pkill -f "opencode serve" 2>/dev/null; sleep 2`

- [ ] **Step 3: Run startup timing test**

Launch the built app and measure:
```bash
START_TIME=$(python3 -c "import time; print(int(time.time()*1000))")
echo "=== START: $(date '+%H:%M:%S.%3N') ==="

/Applications/TeamClaw.app/Contents/MacOS/teamclaw 2>&1 &

SIDECAR_FOUND=0
for i in $(seq 1 40); do
    sleep 0.5
    NOW=$(python3 -c "import time; print(int(time.time()*1000))")
    ELAPSED=$((NOW - START_TIME))
    if ps aux | grep -q "[o]pencode serve"; then
        if [ $SIDECAR_FOUND -eq 0 ]; then
            echo "=== SIDECAR PROCESS at ${ELAPSED}ms ==="
            SIDECAR_FOUND=1
        fi
        if curl -s http://127.0.0.1:13141/health > /dev/null 2>&1; then
            echo "=== SIDECAR READY at ${ELAPSED}ms ==="
            break
        fi
    fi
done
```

Expected:
- `[Startup]` timing lines visible in stderr
- Sidecar ready at ~1.8-2.0s (down from ~3.3s)
- No white screen (skeleton visible immediately)

- [ ] **Step 4: Run 3 times and record results**

Repeat step 3 two more times (kill between runs). Record all three sidecar-ready times.
Expected: Consistently ≤2.5s (with some variance for system load).

- [ ] **Step 5: Verify all services still work**

After startup, verify:
- Chat is functional (send a message)
- OSS sync status shows in settings (initialized after sidecar ready)
- Team sync works (check console for "Team repo sync completed")
- Cron jobs load (if configured)

- [ ] **Step 6: Final commit with results**

```bash
git commit --allow-empty -m "perf(startup): verified startup acceleration

Baseline: ~3.3s to sidecar ready
After: ~X.Xs (fill in measured value)
Changes: deferred OssRestore/team sync, skeleton screen, bundle split, timing instrumentation"
```
