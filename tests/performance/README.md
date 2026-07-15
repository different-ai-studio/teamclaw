# Performance benchmarks

tauri-mcp–driven UX micro-benchmarks for the desktop app. Pure data
collection (no pass/fail thresholds); each run writes a JSON report to
`tests/performance/reports/` (gitignored).

| File | Scenarios |
|---|---|
| `frontend-load.test.ts` | `PERF-01` app launches and window becomes visible within timeout |
| `ux-responsiveness.test.ts` | `COLD-01/02` cold FCP/TTI · `HOT-01` hot render · `SESSION-01` switch latency · `INPUT-01` composer input delay · `RENDER-01/02` large text / code-block paint |

## Running

The harness drives the app over the tauri-mcp Unix socket
(`/tmp/tauri-mcp.sock`) using two webview hooks that are **DEV-only**:

- the store bridge `window.__TEAMCLAW_STORES__` **and** the `execute-js`
  listener — installed by `packages/app/src/stores/dev-expose.ts` only under
  `import.meta.env.DEV`;
- the seed surface `window.__TEAMCLAW_V2_E2E__` — installed by
  `packages/app/src/lib/e2e/v2-control.ts` only when `VITE_TEAMCLAW_E2E=true`.

A plain `tauri:build` / spawned release binary embeds a **production** frontend
that has neither, so the socket connects but `execute_js` finds no listener and
every store-driven scenario fails. Run against a **DEV-mode** app instead:

```bash
# shell 1 — dev app (installs the bridge, the execute-js listener, and the
# E2E seed surface). Leave it running.
VITE_TEAMCLAW_E2E=true pnpm tauri:dev

# shell 2 — the suite auto-attaches to the running app via the socket
pnpm test:e2e:performance
```

`launchTeamClawApp()` reuses an already-running app when the socket is alive, so
the dev app from shell 1 is what gets measured.

### Why `VITE_TEAMCLAW_E2E=true`

`HOT-01` and `SESSION-01` need real sessions to render. The production
`createSession()` path requires an FC-provisioned team (`currentTeam.id`), which
a plain dev login does not have — so without the flag those two scenarios
**skip**. With the flag, they seed synthetic sessions directly into the stores
via `window.__TEAMCLAW_V2_E2E__.seedConversation` (no backend, no agent
runtime), then measure the store→DOM render. The app must already be past
`AuthGate` (a persisted dev login is enough; seeding does not bypass auth).

The remaining scenarios (cold start, input, render) are DOM-only and produce
data with or without the flag.
