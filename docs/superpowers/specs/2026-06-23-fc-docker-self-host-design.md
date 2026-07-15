# FC service: run in Docker (self-host target)

**Date:** 2026-06-23
**Status:** Approved design
**Scope:** `services/fc/`

## Goal

Make Docker a real deployment target for the TeamClaw Cloud API (`services/fc`)
that can stand in for Alibaba Function Compute (FC), while the existing FC
deploy path — `dist/index.handler`, `s.yaml`, and `.github/workflows/fc-deploy.yml`
— stays 100% intact and functional.

## Background

The service is a [Hono](https://hono.dev) app. All routing/business logic lives
in `createApp(deps)` (`src/app.ts`). Today it is exposed two ways from
`src/index.ts`:

- HTTP: `const honoHandler = handle(app)` via `hono/aws-lambda`, re-exported as
  `handler(event, context)` — the FC entrypoint (`handler: dist/index.handler`).
- Cron: FC **timer** events are intercepted in `handler` *before* the Hono app
  (`isTimerEvent(event)` → `runCronTask(getDb(), payload.task)`).

`index.ts` already exports the dependency factories `makeAuthRepoFactory` and
`makeBusinessRepoFactory`, and `resolveBackendKind()` chooses the backend
(`supabase` | `postgres`) from env. All runtime config (DB, Supabase, OSS,
LiteLLM, APNs, MQTT, CodeUp, ~25 vars) is supplied via environment variables,
already enumerated in `s.yaml`.

Cron tasks dispatched by `runCronTask` (`src/lib/cron.ts`):
- `oss-abandon-sessions`
- `oss-gc-blobs`

## Non-goals (YAGNI)

- No in-container scheduler (no `node-cron`); cron is HTTP-triggered.
- No bundling of Postgres / Supabase / MQTT / OSS into the image — these stay
  external, exactly as with FC.
- No change to `s.yaml`, the Lambda `handler` export, or `fc-deploy.yml`.
- No new business endpoints.

## Design

### 1. Shared deps module — `src/make-deps.ts`

Extract the existing deps-wiring currently in `index.ts` into a small shared
module so both entrypoints construct identical dependencies with no duplication:

- `makeAuthRepoFactory(kind)`
- `makeBusinessRepoFactory(kind, ...)`
- any closure-level env reads they rely on

`index.ts` imports these (behavior unchanged; the Lambda `handler` export and
timer handling are untouched). `server.ts` imports the same module.

> If a clean extraction proves noisy, the fallback is for `server.ts` to import
> the already-exported `makeAuthRepoFactory` / `makeBusinessRepoFactory` from
> `index.ts` directly. The shared module is preferred for clarity but the
> contract is "no duplicated deps logic."

### 2. New Node HTTP entrypoint — `src/server.ts`

Serve the **same** `createApp(deps)` app with `@hono/node-server`:

- Resolve backend with `resolveBackendKind()`.
- Build `deps` from the shared module.
- `serve({ fetch: app.fetch, port, hostname })`.
- `PORT` (default `9000`) and `HOST` (default `0.0.0.0`) from env.
- Log a startup line with resolved backend kind and port.

The FC timer path has no equivalent here — scheduled work arrives via the HTTP
cron route below.

### 3. Health + cron routes (added once, inside `createApp`)

Added to `createApp` so both the FC and Docker paths expose them (additive,
harmless on FC). Registered as plain routes, NOT under `/v1` (so they bypass
business-route auth) but the cron route is secret-guarded:

- `GET /healthz` → `200 {"ok": true}`. No DB access — pure liveness/readiness
  probe for the container `HEALTHCHECK` and orchestrators.
- `POST /internal/cron`:
  - Requires header `x-cron-secret` to equal `CRON_TRIGGER_SECRET`. If the env
    var is unset OR the header does not match → `401 {"error":"unauthorized"}`.
  - Body `{ "task": "oss-abandon-sessions" | "oss-gc-blobs" }`.
  - Calls `runCronTask(getDb(), task)`; returns its result as JSON.
  - Unknown task → `400 {"error":"unknown_task"}` (mirrors the throw in
    `runCronTask`, caught and mapped).

An external scheduler (k8s CronJob, compose sidecar, host cron, etc.) invokes
`POST /internal/cron` on a schedule for each task. The container stays stateless.

### 4. Dockerfile (multi-stage) + `.dockerignore`

`services/fc/Dockerfile`:

- **Stage 1 — build** (`node:20-slim`): copy `package*.json`, `npm ci`, copy
  source, `npm run build` → `dist/`.
- **Stage 2 — runtime** (`node:20-slim`): copy `package*.json`, install
  production deps only (`npm ci --omit=dev`), copy `dist/` from the build stage,
  run as a non-root user, `EXPOSE 9000`, `HEALTHCHECK` against `/healthz`,
  `CMD ["node", "dist/server.js"]`.

`services/fc/.dockerignore`: exclude `node_modules`, `dist`, `test`, local env
files, `*.log`, etc.

### 5. Supporting changes

- `package.json`: add `@hono/node-server` to `dependencies`; add
  `"start": "node dist/server.js"` script.
- `docker-compose.yml` (in `services/fc/`): single `fc` service,
  `build: .`, `env_file: .env`, `ports: ["9000:9000"]`. DB/Supabase/OSS/MQTT
  remain external (configured through the env file). Intended for local
  self-host / smoke use.
- README note in `services/fc/` documenting:
  - required env vars (reuse the `s.yaml` list),
  - `PORT` / `HOST` / `CRON_TRIGGER_SECRET`,
  - the `/healthz` and `/internal/cron` contract,
  - how to run via `docker compose up`.

## Data flow

```
Client ──HTTP──▶ container :9000 ──▶ @hono/node-server ──▶ createApp(deps) ──▶ routes/*, /sync, admin
Scheduler ──POST /internal/cron (x-cron-secret)──▶ createApp ──▶ runCronTask(getDb(), task)
Probe ──GET /healthz──▶ 200 {ok:true}
```

Backend selection, repositories, Supabase/Postgres passthrough, OSS, LiteLLM,
APNs, MQTT — all unchanged; reused verbatim through `createApp` and the shared
deps module.

## Error handling

- `/internal/cron`: missing/wrong secret → 401; missing `task` → 400; unknown
  task → 400; task throw → propagates to the existing `app.onError` → 500.
- `server.ts`: a failure to resolve backend or required env should log a clear
  message and exit non-zero so the container restarts/visible-fails (fail fast).
- `/healthz` never touches the DB so a DB outage does not flap liveness;
  readiness of dependencies is the orchestrator's concern via real traffic.

## Testing

- Unit: a test for the `/internal/cron` guard (401 without secret, 400 on
  unknown task, success path mocked) and `/healthz` returning 200 — added to
  `services/fc/test/` using the existing `createApp`-based test harness.
- Existing FC tests (including `sync-versions-query.test.ts`) must stay green —
  the refactor must not change their contracts.
- Manual: `docker compose up`, curl `/healthz`, curl `/internal/cron` with and
  without the secret, hit a `/v1` route against a dev/test DB.

## Acceptance criteria

1. `docker compose up` (or `docker build` + `docker run --env-file`) starts the
   service and serves the full API on `:9000`.
2. `GET /healthz` returns `200 {"ok":true}`.
3. `POST /internal/cron` runs both cron tasks when given the correct secret and
   rejects unauthenticated calls.
4. `npm run build`, `npm run typecheck`, and `npm test` all pass.
5. FC path unchanged: `dist/index.handler` export, `s.yaml`, and `fc-deploy.yml`
   are untouched and still deployable.
