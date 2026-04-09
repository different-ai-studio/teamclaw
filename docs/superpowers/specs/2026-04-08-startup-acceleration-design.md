# Startup Acceleration Design

**Date**: 2026-04-08
**Goal**: Reduce startup time to ≤2-3 seconds (UI + sidecar ready, able to send messages)
**Scope**: Optimized warm start with saved workspace

## Problem Statement

Release build startup takes ~3.3s to reach "sidecar ready" state. Users experience:
- White screen for ~500ms during JS bundle parsing
- Services loading one by one after sidecar ready
- Perceived slowness and instability

## Measured Baseline (Release Build)

Two runs of `/Applications/TeamClaw.app`:

| Metric | Run 1 (cold) | Run 2 (warm) |
|--------|-------------|-------------|
| Sidecar process found | 1406ms | 555ms |
| Sidecar health OK | **3394ms** | **3341ms** |
| OssRestore FC token request | 1997ms | 1692ms |
| OssRestore total | 2444ms | 2161ms |

Debug build comparison: sidecar ready at **1866ms** (no OssRestore running).

### Root Cause

`oss_restore_sync` is triggered by `useOssSyncInit` as soon as workspace is set — before sidecar is ready. This call:
1. Makes a network request to FC for a token (~1.7-2s)
2. Restores 4 loro snapshots (Skills/Mcp/Knowledge/Secrets) with heavy I/O + CPU

This competes with sidecar startup for system resources, inflating sidecar boot time from ~1.8s to ~3.3s.

### Critical Path

```
T+0ms         Tauri window + HTML loads → WHITE SCREEN
T+0ms         [Rust] Early launch begins sidecar async
T+0-500ms     WebView init + 2.4MB JS bundle parse → still white
T+500ms       React mounts, spinner shown
T+500ms       useOssSyncInit fires oss_restore_sync ← resource contention starts
T+500-3200ms  Sidecar startup slowed by competing I/O
T+3341ms      Sidecar health OK → app usable
```

## Design

Two complementary strategies:
- **A) Defer non-critical tasks** — eliminate resource contention (real speedup)
- **B) Frontend bundle + skeleton** — eliminate white screen (perceived speedup)

---

## A) Defer Non-Critical Tasks Until Sidecar Ready

### Principle

Before `openCodeReady === true`, only the sidecar startup itself should consume significant system resources. All other services defer.

### A1: `useOssSyncInit` — defer to openCodeReady

**File**: `packages/app/src/hooks/useAppInit.ts` (~line 534)

Current: triggers `oss_restore_sync` when `workspacePath` is set.
Change: add `openCodeReady` to the dependency guard.

```typescript
export function useOssSyncInit() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openCodeReady = useWorkspaceStore((s) => s.openCodeReady);
  const initialize = useTeamOssStore((s) => s.initialize);
  const cleanup = useTeamOssStore((s) => s.cleanup);

  useEffect(() => {
    if (!workspacePath || !openCodeReady || !isTauri()) return;
    cleanup();
    initialize(workspacePath).catch((err: unknown) => {
      console.warn("[App] OSS sync init failed (non-critical):", err);
    });
    return () => { cleanup(); };
  }, [workspacePath, openCodeReady, initialize, cleanup]);
}
```

**Impact**: Eliminates the biggest resource competitor. Expected sidecar time: 3.3s → ~1.8-2.0s.

### A2: `useGitReposInit` — defer team sync to openCodeReady

**File**: `packages/app/src/hooks/useAppInit.ts` (~line 349)

The `team_sync_repo` invoke does a network git pull. Defer this part to after `openCodeReady`. Local git repos initialization (non-network) can remain as-is.

### A3: `useCronInit` — defer cron_init invoke

**File**: `packages/app/src/hooks/useAppInit.ts` (~line 497)

Lower priority, but `cron_init` invoke should also wait for `openCodeReady` since cron jobs depend on sidecar anyway.

### Not changed

- `useChannelGatewayInit` — already waits for `openCodeReady` ✓
- RAG HTTP server — async spawn, lightweight ✓
- P2P node — lazy init, only if configured ✓
- FileWatcher — lightweight, no I/O contention ✓

---

## B) Frontend Bundle Optimization + Skeleton Screen

### B1: Inline skeleton screen in index.html

**File**: `packages/app/index.html`

Add a pure CSS/HTML skeleton that mimics the app's sidebar + main area layout. Zero JS — visible the instant WebView renders the HTML.

Key requirements:
- Read theme from localStorage key `${appShortName}-theme` (e.g. `teamclaw-theme`) with inline `<script>` — same logic as `main.tsx` line 21. Values: `'dark'`, `'light'`, or `'system'` (default)
- Use CSS `color-scheme` and CSS variables for theme adaptation
- Skeleton is removed by React in `main.tsx` on mount: `document.getElementById('skeleton')?.remove()`
- Must match the actual app layout proportions (320px sidebar, flex-1 main area)

**Impact**: White screen eliminated. 0ms to first visual.

### B2: Split the 2.4MB main chunk

**File**: `packages/app/vite.config.ts` (rollupOptions.output.manualChunks)

Current state: single `index-*.js` at 2.4MB. Editor components already have separate chunks but the main bundle is still oversized.

Changes:
1. Add `manualChunks` entries for Tauri APIs and i18n:
   ```typescript
   'tauri': [
     '@tauri-apps/api',
     '@tauri-apps/plugin-fs',
     '@tauri-apps/plugin-shell',
     '@tauri-apps/plugin-dialog',
     '@tauri-apps/plugin-notification',
     '@tauri-apps/plugin-process',
   ],
   'i18n': ['i18next', 'react-i18next'],
   ```

2. Verify editor components use `React.lazy()` imports (TiptapMarkdownEditor, CodeEditor, PDFViewer) — if any are statically imported, convert to lazy.

3. Run `ANALYZE=true pnpm build` before and after to measure actual chunk size reduction.

**Target**: Main chunk from 2.4MB → ~1.2-1.5MB. JS parse time reduction ~40%.

### B3: Startup timing instrumentation

Add lightweight performance markers for ongoing optimization:

**Rust side** (`src-tauri/src/lib.rs`):
- Keep `[Startup]` timing markers in release builds (currently debug-only), at least for: `fix_path_env`, `setup hook`, `start_opencode_inner TOTAL`

**Frontend side** (`packages/app/src/main.tsx`, `packages/app/src/hooks/useAppInit.ts`):
- `performance.mark('react-mount')` in main.tsx
- `performance.mark('workspace-restored')` after localStorage restore
- `performance.mark('opencode-ready')` when sidecar is confirmed ready
- `performance.measure()` to compute intervals
- Log a single summary line: `[Startup] skeleton→react: Xms, react→sidecar: Yms, total: Zms`

---

## Expected Results

| Phase | Before | After |
|-------|--------|-------|
| White screen | ~500ms | **0ms** (skeleton) |
| JS parse time | ~500ms (2.4MB) | ~300ms (~1.4MB) |
| Sidecar ready | 3.3s | **~1.8-2.0s** (no contention) |
| **Total to usable** | **~3.3s** | **~2.0s** |

With skeleton screen, perceived startup is even faster since users see meaningful UI immediately.

## Verification Plan

1. Run release build 3 times, measure sidecar ready time with timing instrumentation
2. Compare main chunk size before/after with `ANALYZE=true pnpm build`
3. Visually verify skeleton screen matches app layout in both dark and light themes
4. Confirm OssRestore/team sync/cron still initialize correctly after sidecar ready
5. Test edge case: workspace that no longer exists (skeleton → workspace prompt)

## Files to Modify

| File | Change |
|------|--------|
| `packages/app/src/hooks/useAppInit.ts` | A1: useOssSyncInit guard, A2: useGitReposInit defer team sync, A3: useCronInit guard, B3: frontend timing marks |
| `packages/app/index.html` | B1: inline skeleton screen with theme-aware `<script>` |
| `packages/app/src/main.tsx` | B1: remove skeleton on mount, B3: timing marks |
| `packages/app/vite.config.ts` | B2: additional manualChunks |
| `src-tauri/src/lib.rs` | B3: release timing markers |
