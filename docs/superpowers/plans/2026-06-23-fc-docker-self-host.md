# FC Service Docker Self-Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the `services/fc` Hono app as a standalone Docker container that can self-host the TeamClaw Cloud API, without changing the existing Alibaba FC deploy path.

**Architecture:** The app already lives in `createApp(deps)` (`src/app.ts`). FC wraps it with `hono/aws-lambda`; we add a second entrypoint `src/server.ts` that wraps the *same* app with `@hono/node-server`. Health and HTTP-cron routes are added once inside `createApp` so both paths share them. A multi-stage Dockerfile builds and runs `dist/server.js`.

**Tech Stack:** TypeScript (ESM, NodeNext), Hono, `@hono/node-server`, Node 20, Docker, `node:test` runner.

## Global Constraints

- All commands run from `services/fc/` unless noted. The repo root is the worktree at `/Volumes/openbeta/workspace/teamclaw-v2-worktrees/task/refactor-fc-service-can-run-in-the-docker`.
- ESM with NodeNext resolution: **all relative imports use the `.js` extension** even though sources are `.ts` (e.g. `import { createApp } from "./app.js"`).
- Do NOT modify: `src/index.ts`'s `handler` export semantics, `s.yaml`, or `.github/workflows/fc-deploy.yml`. Additive changes to `src/app.ts` and `src/index.ts` are allowed.
- Cron task names (from `src/lib/cron.ts`): `oss-abandon-sessions`, `oss-gc-blobs`. Unknown task → `runCronTask` throws `Unknown cron task: <task>`.
- Tests use the `node:test` runner via `npm test` (`node --import tsx --test "test/**/*.test.ts"`). Hono tests issue requests with `app.request(path, init)`.
- Default container port `9000`, host `0.0.0.0`. Cron secret header is `x-cron-secret`, env var `CRON_TRIGGER_SECRET`.

## File Structure

- `src/app.ts` — **modify**: add `GET /healthz` and `POST /internal/cron` inside `createApp`. New optional dep `runCron` on `AppDeps`.
- `src/server.ts` — **create**: Node HTTP entrypoint serving `createApp` via `@hono/node-server`.
- `test/health-cron.test.ts` — **create**: tests for `/healthz` and `/internal/cron` guard/dispatch.
- `package.json` — **modify**: add `@hono/node-server` dep + `start` script.
- `Dockerfile` — **create**: multi-stage build → `node dist/server.js`.
- `.dockerignore` — **create**.
- `docker-compose.yml` — **create**: local self-host service.
- `README.md` — **create/modify**: document env, ports, cron contract, docker usage.

---

### Task 1: Add health + cron routes to `createApp`

Add the two shared routes inside the existing Hono app. The cron task runner is injected as an optional dep (`runCron`) so the route stays testable without a real DB and `app.ts` keeps no DB import.

**Files:**
- Modify: `src/app.ts`
- Test: `test/health-cron.test.ts`

**Interfaces:**
- Consumes: existing `createApp(deps: AppDeps): Hono`, `AppDeps` type.
- Produces:
  - Extended `AppDeps` with optional `runCron?: (task: string) => Promise<unknown>`.
  - Route `GET /healthz` → `200 { ok: true }`.
  - Route `POST /internal/cron` → header `x-cron-secret` must equal `process.env.CRON_TRIGGER_SECRET`; body `{ task: string }`; calls `deps.runCron(task)`.

- [ ] **Step 1: Write the failing test**

Create `test/health-cron.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

function deps(over: Record<string, any> = {}) {
  return {
    createRepository: () => ({}),
    createAuthRepository: () => ({}),
    ...over,
  } as any;
}

test("GET /healthz returns 200 ok:true", async () => {
  const app = createApp(deps());
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /internal/cron rejects without secret", async () => {
  process.env.CRON_TRIGGER_SECRET = "s3cret";
  const app = createApp(deps());
  const res = await app.request("/internal/cron", {
    method: "POST",
    body: JSON.stringify({ task: "oss-gc-blobs" }),
  });
  assert.equal(res.status, 401);
});

test("POST /internal/cron rejects wrong secret", async () => {
  process.env.CRON_TRIGGER_SECRET = "s3cret";
  const app = createApp(deps());
  const res = await app.request("/internal/cron", {
    method: "POST",
    headers: { "x-cron-secret": "nope" },
    body: JSON.stringify({ task: "oss-gc-blobs" }),
  });
  assert.equal(res.status, 401);
});

test("POST /internal/cron runs task with correct secret", async () => {
  process.env.CRON_TRIGGER_SECRET = "s3cret";
  let called = "";
  const app = createApp(deps({ runCron: async (t: string) => { called = t; return { ok: 1 }; } }));
  const res = await app.request("/internal/cron", {
    method: "POST",
    headers: { "x-cron-secret": "s3cret" },
    body: JSON.stringify({ task: "oss-gc-blobs" }),
  });
  assert.equal(res.status, 200);
  assert.equal(called, "oss-gc-blobs");
  assert.deepEqual(await res.json(), { ok: 1 });
});

test("POST /internal/cron 400 on unknown task", async () => {
  process.env.CRON_TRIGGER_SECRET = "s3cret";
  const app = createApp(deps({
    runCron: async (t: string) => { throw new Error(`Unknown cron task: ${t}`); },
  }));
  const res = await app.request("/internal/cron", {
    method: "POST",
    headers: { "x-cron-secret": "s3cret" },
    body: JSON.stringify({ task: "bogus" }),
  });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- 2>&1 | grep -A2 health-cron` (or `node --import tsx --test test/health-cron.test.ts`)
Expected: FAIL — `/healthz` returns 404 (route not registered).

- [ ] **Step 3: Extend `AppDeps` and register routes**

In `src/app.ts`, add `runCron` to the `AppDeps` type:

```ts
export type AppDeps = {
  createRepository: (args: { accessToken: string }) => unknown;
  createAuthRepository: () => unknown;
  runCron?: (task: string) => Promise<unknown>;
};
```

Then inside `createApp`, AFTER `const app = new Hono();` and the `app.options("*", ...)` line, BEFORE the `/v1` adapter registration, add:

```ts
  // Container liveness/readiness probe — no DB access.
  app.get("/healthz", (c) => c.json({ ok: true }));

  // HTTP-triggered cron (replaces FC timer for the Docker/self-host path).
  // Guarded by a shared secret; an external scheduler POSTs { task }.
  app.post("/internal/cron", async (c) => {
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret || c.req.header("x-cron-secret") !== secret) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!deps.runCron) {
      return c.json({ error: "cron_unavailable" }, 503);
    }
    const t = await c.req.text();
    let body: any = {};
    if (t) { try { body = JSON.parse(t); } catch { return c.json({ error: "Invalid JSON body" }, 400); } }
    if (!body.task || typeof body.task !== "string") {
      return c.json({ error: "missing_task" }, 400);
    }
    try {
      const result = await deps.runCron(body.task);
      return c.json(result as any);
    } catch (err: any) {
      if (String(err?.message).startsWith("Unknown cron task")) {
        return c.json({ error: "unknown_task" }, 400);
      }
      throw err;
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/health-cron.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Run full suite + typecheck to confirm no regression**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; existing tests (incl. `app-v1.test.ts`, `sync-versions-query.test.ts`) still pass.

- [ ] **Step 6: Commit**

```bash
git add src/app.ts test/health-cron.test.ts
git commit -m "feat(fc): add /healthz and /internal/cron routes to createApp"
```

---

### Task 2: Wire `runCron` into the FC handler deps (no behavior change)

So the new dep is supplied on the existing FC path too (FC still uses timer events for cron, but supplying `runCron` keeps both entrypoints consistent and lets `/internal/cron` work if ever called on FC).

**Files:**
- Modify: `src/index.ts` (the module-level `createApp({...})` call only)

**Interfaces:**
- Consumes: `createApp` (now accepts `runCron`), `runCronTask` (already imported), `getDb` (already imported).
- Produces: FC `app` built with `runCron` supplied.

- [ ] **Step 1: Add `runCron` to the existing createApp call**

In `src/index.ts`, locate:

```ts
const app = createApp({
  createRepository: makeBusinessRepoFactory(resolveBackendKind()),
  createAuthRepository: makeAuthRepoFactory(resolveBackendKind()),
});
```

Change to:

```ts
const app = createApp({
  createRepository: makeBusinessRepoFactory(resolveBackendKind()),
  createAuthRepository: makeAuthRepoFactory(resolveBackendKind()),
  runCron: (task: string) => runCronTask(getDb(), task),
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (no type errors).

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: all tests pass; FC handler semantics unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(fc): supply runCron dep on the FC handler app"
```

---

### Task 3: Add `@hono/node-server` dependency

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `serve` from `@hono/node-server` available to `src/server.ts`.

- [ ] **Step 1: Install the dependency**

Run: `npm install @hono/node-server@^1.13.0`
Expected: `package.json` `dependencies` gains `@hono/node-server`; `package-lock.json` updated.

- [ ] **Step 2: Add a `start` script**

In `package.json` `scripts`, add:

```json
    "start": "node dist/server.js",
```

- [ ] **Step 3: Verify install**

Run: `node -e "import('@hono/node-server').then(m => console.log(typeof m.serve))"`
Expected: prints `function`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(fc): add @hono/node-server and start script"
```

---

### Task 4: Create the Node HTTP entrypoint `src/server.ts`

Serve the same `createApp` app via `@hono/node-server`, sourcing deps from the already-exported factories in `index.ts` (DRY — no duplicated repo wiring).

**Files:**
- Create: `src/server.ts`

**Interfaces:**
- Consumes: `createApp` (`./app.js`), `resolveBackendKind` (`./lib/backend-kind.js`), `makeBusinessRepoFactory` / `makeAuthRepoFactory` (`./index.js`), `runCronTask` (`./lib/cron.js`), `getDb` (`./db/client.js`).
- Produces: a process that listens on `PORT` (default 9000), host `HOST` (default `0.0.0.0`).

> Note: importing `./index.js` is safe — it has no top-level side effect that listens or exits; it only builds the FC `app` and exports `handler`. We reuse its repo factories rather than rebuilding them.

- [ ] **Step 1: Write `src/server.ts`**

```ts
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { resolveBackendKind } from "./lib/backend-kind.js";
import { makeBusinessRepoFactory, makeAuthRepoFactory } from "./index.js";
import { runCronTask } from "./lib/cron.js";
import { getDb } from "./db/client.js";

const kind = resolveBackendKind();

const app = createApp({
  createRepository: makeBusinessRepoFactory(kind),
  createAuthRepository: makeAuthRepoFactory(kind),
  runCron: (task: string) => runCronTask(getDb(), task),
});

const port = Number(process.env.PORT ?? 9000);
const hostname = process.env.HOST ?? "0.0.0.0";

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[fc] listening on http://${hostname}:${info.port} (backend=${kind})`);
});
```

- [ ] **Step 2: Build and verify it compiles into dist**

Run: `npm run build && test -f dist/server.js && echo OK`
Expected: prints `OK` (no tsc errors, `dist/server.js` exists).

- [ ] **Step 3: Smoke-run the server against /healthz**

Run:
```bash
PORT=9099 CRON_TRIGGER_SECRET=test node dist/server.js & SRV=$!; sleep 1; \
curl -fsS http://127.0.0.1:9099/healthz; echo; kill $SRV
```
Expected: prints `{"ok":true}`. (Backend env may be unset — `/healthz` does not touch the DB, so it still responds 200. A startup log line appears.)

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(fc): add @hono/node-server entrypoint for Docker self-host"
```

---

### Task 5: Add Dockerfile and `.dockerignore`

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Produces: an image whose `CMD` runs `node dist/server.js`, exposing port 9000.

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
dist
test
*.log
.env
.env.*
.git
Dockerfile
docker-compose.yml
README.md
```

- [ ] **Step 2: Write `Dockerfile`**

```dockerfile
# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 9000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
```

- [ ] **Step 3: Build the image**

Run: `docker build -t teamclaw-fc:dev .`
Expected: build completes; final stage tagged `teamclaw-fc:dev`.

- [ ] **Step 4: Run the container and probe /healthz**

Run:
```bash
docker run --rm -d -p 9098:9000 -e CRON_TRIGGER_SECRET=test --name fc-smoke teamclaw-fc:dev; \
sleep 2; curl -fsS http://127.0.0.1:9098/healthz; echo; docker stop fc-smoke
```
Expected: prints `{"ok":true}`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat(fc): add multi-stage Dockerfile and .dockerignore"
```

---

### Task 6: Add `docker-compose.yml` for local self-host

**Files:**
- Create: `docker-compose.yml`

**Interfaces:**
- Produces: a `fc` service buildable/runnable with `docker compose up`, config via `.env`.

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  fc:
    build: .
    image: teamclaw-fc:dev
    env_file:
      - .env
    environment:
      PORT: "9000"
      HOST: "0.0.0.0"
    ports:
      - "9000:9000"
    restart: unless-stopped
```

- [ ] **Step 2: Validate compose config**

Run: `docker compose config >/dev/null && echo OK`
Expected: prints `OK` (compose file parses; missing `.env` is fine for validation — create an empty one if needed: `touch .env`).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(fc): add docker-compose for local self-host"
```

---

### Task 7: Document Docker self-host in README

**Files:**
- Create or Modify: `README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Write the README section**

Create `README.md` (or append a section if it exists) containing:

```markdown
# teamclaw-fc

The TeamClaw Cloud API (Hono). Deploys to Alibaba Function Compute via
`s.yaml` / `fc-deploy.yml`, and also runs as a standalone Docker container
for self-hosting.

## Run in Docker (self-host)

The container serves the full `/v1` API plus `/healthz` and `/internal/cron`.
All backing services (Postgres/Supabase, OSS, MQTT, LiteLLM) stay external and
are configured through environment variables — the same set listed in `s.yaml`.

```bash
cp .env.example .env   # fill in the values (see s.yaml for the full list)
docker compose up --build
curl http://127.0.0.1:9000/healthz   # {"ok":true}
```

### Container-specific env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `9000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `CRON_TRIGGER_SECRET` | (unset) | Shared secret required by `/internal/cron` |
| `BACKEND_KIND` | `supabase` | `supabase` or `postgres` (via `resolveBackendKind`) |

All other vars (DB, Supabase, OSS, LiteLLM, APNs, MQTT, CodeUp) match `s.yaml`.

### Cron (HTTP-triggered)

Alibaba FC drives cron via timer triggers. In Docker, an external scheduler
POSTs to `/internal/cron` instead. Run each task on its own schedule:

```bash
curl -X POST http://127.0.0.1:9000/internal/cron \
  -H "x-cron-secret: $CRON_TRIGGER_SECRET" \
  -H "content-type: application/json" \
  -d '{"task":"oss-abandon-sessions"}'

curl -X POST http://127.0.0.1:9000/internal/cron \
  -H "x-cron-secret: $CRON_TRIGGER_SECRET" \
  -H "content-type: application/json" \
  -d '{"task":"oss-gc-blobs"}'
```

Tasks: `oss-abandon-sessions`, `oss-gc-blobs`. A missing/wrong secret returns
401; an unknown task returns 400.

The Alibaba FC deploy path (`dist/index.handler`, `s.yaml`, `fc-deploy.yml`) is
unchanged by the Docker support.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(fc): document Docker self-host, env, and cron trigger"
```

---

## Self-Review Notes

- **Spec coverage:** §1 shared deps → Task 4 reuses exported factories from `index.ts` (the spec's documented fallback, chosen to avoid a risky extraction of `provisionAppRepo`/`makeDeployDeps`/push closures). §2 server.ts → Task 4. §3 health+cron in createApp → Tasks 1–2. §4 Dockerfile/.dockerignore → Task 5. §5 package.json/compose/README → Tasks 3, 6, 7. Acceptance criteria 1–5 all covered (build/typecheck/test in Tasks 1–5; FC untouched verified by not editing `s.yaml`/handler export).
- **Deviation from spec:** spec preferred a new `src/make-deps.ts`; this plan uses the spec's explicit fallback (`server.ts` imports the already-exported factories) because those factories pull in many tangled closures (`provisionAppRepo`, `makeDeployDeps`, `pushDeps`) whose extraction would be high-risk for zero behavioral gain. The "no duplicated deps logic" contract is still met.
- **Placeholder scan:** none — all code blocks are concrete.
- **Type consistency:** `runCron?: (task: string) => Promise<unknown>` used identically in Tasks 1, 2, 4. Cron task strings and the `Unknown cron task` prefix match `src/lib/cron.ts`.
```
