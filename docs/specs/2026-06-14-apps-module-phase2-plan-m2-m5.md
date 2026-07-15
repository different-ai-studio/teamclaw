# Apps 模块第二期实现计划 — M2–M5（FC 函数 provisioning + 部署上线 + 桌面 UI）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the M1 provisioning primitives into a working per-app deploy pipeline: the user clicks "Deploy", FC provisions the app's Postgres schema + an Alibaba FC 3.0 function, the daemon builds the seeded TanStack app and hands the artifact to FC via OSS, FC points the function at it and exposes a live URL serving the app against its own Postgres schema.

**Architecture:** FC (`services/fc`) is the privileged control plane — it owns schema provisioning (M1 `ensureAppSchema`) and the Alibaba FC OpenAPI calls (`@alicloud/fc20230330`, M0 SDK spike). The daemon (`apps/daemon`) is the builder — it already clones+seeds the repo; M3 adds build → zip → OSS upload, mirroring `app_seed`. The desktop orchestrates an explicit Deploy button mirroring the existing seed/reseed flow. Deploy lifecycle lives on `fc_status` (orthogonal to `provision_status`).

**Tech Stack:** Node 20 + TS (ESM, `.js` specifiers), `@alicloud/fc20230330@4.7.6` + `@alicloud/openapi-client` `Config`, `node --import tsx --test` + `pglite`; Rust (`apps/daemon`, axum, `tokio::spawn_blocking`, `cargo test --bin amuxd`); React 19 + Zustand + Vitest (`packages/app`).

**Inputs (read before starting):**
- `docs/specs/2026-06-14-apps-module-phase2-design.md` (design, deploy state machine §4).
- `docs/specs/2026-06-14-apps-alicloud-fc-sdk-spike.md` (exact SDK calls — **authoritative for all FC client code**).
- `docs/specs/2026-06-14-apps-fc-runtime-spike.md` (custom-runtime contract: port 9000, bind 0.0.0.0, `node-server` preset → `.output/server/index.mjs`, `command`/`args`/`PORT`).
- M1 module: `services/fc/src/lib/provisioning/{pg-name,app-postgres}.ts`.

**Standing constraints:** production `BACKEND_KIND=supabase` → every new repo method MUST be implemented in BOTH `pg-repo` and `supabase-repo` (phase-1 C1 lesson). FC deploys via GitHub Action only. Surface deploy errors, never swallow (bootstrap-error-surfacing lesson). All work on branch `agent/apps-module` in worktree `/Volumes/openbeta/workspace/teamclaw-v2/.worktrees/apps-module`; subagents must assert the branch before committing.

**Live-gate:** M2–M4 contain Alibaba-FC behaviors the spikes flagged "verify live" (FC endpoint host, `custom` runtime string, error-object shape, cwd, externalized deps, cold-start). **Milestone M4 ends with a manual live-deploy verification** against a real FC account before M5 ships the user-facing button. Tasks that can only be confirmed live are marked **[LIVE-GATE]** and include the exact thing to check.

---

## File Structure

| File | Responsibility | Milestone |
|---|---|---|
| `services/fc/src/lib/provisioning/fc-client.ts` | Thin `@alicloud/fc20230330` wrapper: `ensureFunction`, `updateFunctionCode`, `ensureHttpTrigger`, `getInvokeUrl` | M2 |
| `services/fc/src/lib/provisioning/app-fc-status.ts` | Legal `fc_status` deploy-lifecycle transitions (mirrors `app-status.ts`) | M2 |
| `services/fc/src/lib/provisioning/app-deploy.ts` | Backend-agnostic orchestration: `startDeploy` (schema+function), `finalizeDeploy` (code+trigger) | M2/M4 |
| `services/fc/src/lib/pg-repo/apps.ts` (modify) | `deployApp` / `finalizeDeploy` repo methods + extend `mapApp` with `fcEndpoint`/`fcFunctionName`/`fcRegion` | M2/M4 |
| `services/fc/src/lib/supabase-repo.ts` (modify) | Same two methods on the supabase backend | M2/M4 |
| `services/fc/src/lib/routes/apps.ts` (modify) | `POST /v1/apps/:id/deploy`, `POST /v1/apps/:id/deploy/finalize` | M2/M4 |
| `services/fc/src/index.ts` (modify) | Inject `startDeploy`/`finalizeDeploy` deps into both repos (mirror `provisionAppRepo`) | M2/M4 |
| `docs/openapi/teamclaw-api.v1.yaml` (modify) | Deploy + finalize endpoints; add `fcEndpoint` etc. to the App schema | M2/M4 |
| `apps/daemon/src/sync/app_build.rs` | Build TanStack app → zip `.output` → upload to OSS; mirrors `app_seed.rs` | M3 |
| `apps/daemon/src/http/apps.rs` (modify) | `POST /v1/apps/build` handler (mirrors `seed_app`) | M3 |
| `apps/daemon/src/http/routes.rs` (modify) | Register the build route | M3 |
| `apps/daemon/templates/tanstack-postgres/` (modify) | Make it FC-deployable: `node-server` preset, build script, DB-via-`DATABASE_URL`, app self-migrate on boot | M3 |
| `packages/app/src/lib/backend/types.ts` (modify) | `AppRow.fcEndpoint`/`fcFunctionName`; `AppsBackend.deployApp`/`finalizeDeploy` | M5 |
| `packages/app/src/lib/backend/cloud-api/apps.ts` (modify) | Client methods for deploy + finalize | M5 |
| `packages/app/src/lib/daemon-local-client.ts` (modify) | `buildDaemonApp` (mirror `seedDaemonApp`) | M5 |
| `packages/app/src/stores/apps-store.ts` (modify) | `deploy(appId)` orchestration (deploy → build → finalize → status) | M5 |
| `packages/app/src/components/sidebar/AppsListColumn.tsx` (modify) | Deploy button + `fc_status` badge + live link | M5 |

---

## M2 — FC function provisioning + deploy route (control plane)

### Task 1: `fc_status` deploy-lifecycle transition machine

**Files:** Create `services/fc/src/lib/provisioning/app-fc-status.ts`; Test `services/fc/test/provisioning/app-fc-status.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLegalFcTransition } from "../../src/lib/provisioning/app-fc-status.js";

test("deploy happy path transitions are legal", () => {
  assert.ok(isLegalFcTransition("not_deployed", "awaiting_build"));
  assert.ok(isLegalFcTransition("awaiting_build", "building"));
  assert.ok(isLegalFcTransition("building", "deploying"));
  assert.ok(isLegalFcTransition("deploying", "live"));
});
test("retry from terminal states is legal", () => {
  assert.ok(isLegalFcTransition("live", "awaiting_build"));
  assert.ok(isLegalFcTransition("deploy_error", "awaiting_build"));
});
test("any state may move to deploy_error", () => {
  for (const s of ["awaiting_build", "building", "deploying"]) {
    assert.ok(isLegalFcTransition(s, "deploy_error"), s);
  }
});
test("illegal jumps are rejected", () => {
  assert.equal(isLegalFcTransition("not_deployed", "live"), false);
  assert.equal(isLegalFcTransition("not_deployed", "deploying"), false);
});
test("null/undefined current state is treated as not_deployed", () => {
  assert.ok(isLegalFcTransition(null, "awaiting_build"));
});
```

- [ ] **Step 2: Run → fail.** `cd services/fc && node --import tsx --test test/provisioning/app-fc-status.test.ts` → module not found.

- [ ] **Step 3: Implement** `services/fc/src/lib/provisioning/app-fc-status.ts`:

```typescript
/** Legal fc_status (deploy lifecycle) transitions. Orthogonal to
 *  provision_status (repo/seed lifecycle). A NULL/absent fc_status means the
 *  app has never been deployed and is treated as `not_deployed`. */
const ALLOWED: Record<string, string[]> = {
  not_deployed: ["awaiting_build", "deploy_error"],
  awaiting_build: ["building", "deploy_error"],
  building: ["deploying", "deploy_error"],
  deploying: ["live", "deploy_error"],
  live: ["awaiting_build", "deploy_error"],
  deploy_error: ["awaiting_build", "deploy_error"],
};

export const FC_STATUS_NOT_DEPLOYED = "not_deployed";

export function isLegalFcTransition(from: string | null | undefined, to: string): boolean {
  const cur = from ?? FC_STATUS_NOT_DEPLOYED;
  return (ALLOWED[cur] ?? []).includes(to);
}
```

- [ ] **Step 4: Run → pass** (5 tests).
- [ ] **Step 5: Commit** `git add services/fc/src/lib/provisioning/app-fc-status.ts services/fc/test/provisioning/app-fc-status.test.ts && git commit -m "feat(apps): fc_status deploy-lifecycle transition machine"`

### Task 2: FC client wrapper (`@alicloud/fc20230330`)

> All signatures/field names below are from `docs/specs/2026-06-14-apps-alicloud-fc-sdk-spike.md` (read from the installed `.d.ts`). The wrapper isolates the SDK so routes/orchestration stay testable via a small interface. Unit tests mock the SDK client; **real calls are exercised only at the M4 live-gate.**

**Files:** Create `services/fc/src/lib/provisioning/fc-client.ts`; Test `services/fc/test/provisioning/fc-client.test.ts`

- [ ] **Step 1: Write the failing test** (drives the wrapper against a fake SDK client — no network):

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFcOps } from "../../src/lib/provisioning/fc-client.js";

// Minimal fake of the @alicloud/fc20230330 Client surface we use.
function fakeClient(overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  const base = {
    async getFunction(name: string) { calls.push(["getFunction", name]); return { body: { functionName: name } }; },
    async createFunction(req: any) { calls.push(["createFunction", req]); return { body: {} }; },
    async updateFunction(name: string, req: any) { calls.push(["updateFunction", name, req]); return { body: {} }; },
    async createTrigger(name: string, req: any) { calls.push(["createTrigger", name, req]); return { body: {} }; },
    async getTrigger(name: string, trig: string) { calls.push(["getTrigger", name, trig]); return { body: { httpTrigger: { urlInternet: "https://fn.example.fcapp.run" } } }; },
  };
  return { client: { ...base, ...overrides }, calls };
}

test("ensureFunction creates when GetFunction 404s", async () => {
  const notFound = Object.assign(new Error("not found"), { statusCode: 404, code: "FunctionNotFound" });
  const { client, calls } = fakeClient({ getFunction: async () => { throw notFound; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  assert.ok(calls.some((c) => c[0] === "createFunction"));
  assert.ok(!calls.some((c) => c[0] === "updateFunction"));
});

test("ensureFunction updates code when the function already exists", async () => {
  const { client, calls } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  await ops.ensureFunction("tc-app-1", { ossObjectName: "apps/1/code.zip", env: { PORT: "9000" } });
  assert.ok(calls.some((c) => c[0] === "updateFunction"));
  assert.ok(!calls.some((c) => c[0] === "createFunction"));
});

test("ensureHttpTrigger returns the public invoke URL", async () => {
  const { client } = fakeClient();
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  const url = await ops.ensureHttpTrigger("tc-app-1");
  assert.equal(url, "https://fn.example.fcapp.run");
});

test("ensureHttpTrigger swallows 'trigger already exists' then reads the URL", async () => {
  const conflict = Object.assign(new Error("exists"), { statusCode: 409, code: "TriggerAlreadyExists" });
  const { client } = fakeClient({ createTrigger: async () => { throw conflict; } });
  const ops = makeFcOps(client as any, { bucket: "b", role: "acs:ram::1:role/fc" });
  const url = await ops.ensureHttpTrigger("tc-app-1");
  assert.equal(url, "https://fn.example.fcapp.run");
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `services/fc/src/lib/provisioning/fc-client.ts`. Use the model classes per the SDK spike §2–§5. Keep the construction in a separate exported `getFcClient()` so tests inject a fake into `makeFcOps`:

```typescript
import FcClient from "@alicloud/fc20230330";
import * as $fc from "@alicloud/fc20230330";
import { Config } from "@alicloud/openapi-client";

const REGION = () => process.env.REGION || "cn-hangzhou";

// FC 3.0 data-plane host is ACCOUNT-scoped: <accountId>.<region>.fc.aliyuncs.com.
// The OSS ENDPOINT env (oss.ts) is NOT reusable. Provide FC_ENDPOINT directly,
// or compose from ALIYUN_ACCOUNT_ID. [LIVE-GATE: confirm host in M4.]
export function getFcClient(): FcClient {
  const endpoint = process.env.FC_ENDPOINT
    || `${process.env.ALIYUN_ACCOUNT_ID}.${REGION()}.fc.aliyuncs.com`;
  return new FcClient(new Config({
    accessKeyId: process.env.ACCESS_KEY_ID,
    accessKeySecret: process.env.ACCESS_KEY_SECRET,
    regionId: REGION(),
    endpoint,
  }) as any);
}

export interface FcOpsConfig { bucket: string; role: string | undefined; }
export interface EnsureFunctionArgs { ossObjectName: string; env: Record<string, string>; }

function isNotFound(e: any): boolean {
  return e?.statusCode === 404 || e?.code === "FunctionNotFound" || e?.data?.Code === "FunctionNotFound";
}
function isAlreadyExists(e: any): boolean {
  return e?.statusCode === 409 || /AlreadyExists/i.test(e?.code ?? e?.data?.Code ?? "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeFcOps(client: any, cfg: FcOpsConfig) {
  function codeLocation(ossObjectName: string) {
    return new $fc.InputCodeLocation({ ossBucketName: cfg.bucket, ossObjectName });
  }
  return {
    // Idempotent: create if absent, else update the code pointer + env.
    async ensureFunction(functionName: string, args: EnsureFunctionArgs): Promise<void> {
      let exists = true;
      try { await client.getFunction(functionName, new $fc.GetFunctionRequest({})); }
      catch (e) { if (isNotFound(e)) exists = false; else throw e; }
      if (!exists) {
        await client.createFunction(new $fc.CreateFunctionRequest({
          body: new $fc.CreateFunctionInput({
            functionName,
            runtime: "custom.debian10", // [LIVE-GATE: confirm runtime string in M4]
            handler: "index.handler",
            memorySize: 512, cpu: 0.5, timeout: 60, diskSize: 512,
            role: cfg.role,
            environmentVariables: args.env,
            customRuntimeConfig: new $fc.CustomRuntimeConfig({
              command: ["node"], args: [".output/server/index.mjs"], port: 9000,
            }),
            code: codeLocation(args.ossObjectName),
          }),
        }));
      } else {
        await this.updateFunctionCode(functionName, args);
      }
    },
    async updateFunctionCode(functionName: string, args: EnsureFunctionArgs): Promise<void> {
      await client.updateFunction(functionName, new $fc.UpdateFunctionRequest({
        body: new $fc.UpdateFunctionInput({
          environmentVariables: args.env,
          code: codeLocation(args.ossObjectName),
        }),
      }));
    },
    // Idempotent: create the http trigger (ignore "already exists"), then read URL.
    async ensureHttpTrigger(functionName: string): Promise<string> {
      try {
        await client.createTrigger(functionName, new $fc.CreateTriggerRequest({
          body: new $fc.CreateTriggerInput({
            triggerName: "http", triggerType: "http",
            triggerConfig: JSON.stringify({ authType: "anonymous", methods: ["GET", "POST", "PUT", "DELETE"] }),
          }),
        }));
      } catch (e) { if (!isAlreadyExists(e)) throw e; }
      const t = await client.getTrigger(functionName, "http");
      const url = t?.body?.httpTrigger?.urlInternet;
      if (!url) throw new Error("http trigger has no urlInternet");
      return url;
    },
  };
}
```

- [ ] **Step 4: Run → pass** (4 tests). [LIVE-GATE notes intentionally left as comments; do not attempt real calls here.]
- [ ] **Step 5: Typecheck** `cd services/fc && pnpm typecheck` (the `$fc` model imports must resolve; if the barrel import path differs, adjust per SDK-spike §7 and re-run). Expected: clean.
- [ ] **Step 6: Commit** `git add services/fc/src/lib/provisioning/fc-client.ts services/fc/test/provisioning/fc-client.test.ts && git commit -m "feat(apps): @alicloud FC client wrapper (ensure function/trigger, idempotent)"`

### Task 3: deploy orchestration — `startDeploy`

> Backend-agnostic. Combines M1 `ensureAppSchema` + Task-2 `ensureFunction`. Returns the data the route writes back to the app row + the OSS object key the daemon must upload to.

**Files:** Create `services/fc/src/lib/provisioning/app-deploy.ts`; Test `services/fc/test/provisioning/app-deploy.test.ts`

- [ ] **Step 1: Write the failing test** (inject fakes for the schema executor + fc ops):

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDeploy } from "../../src/lib/provisioning/app-deploy.js";

test("startDeploy provisions schema + function and returns fc identity + oss key", async () => {
  const ensured: any[] = [];
  const deps = {
    adminExec: async () => {},                                   // ensureAppSchema runs DDL (no-op here)
    fcOps: { ensureFunction: async (n: string, a: any) => { ensured.push([n, a]); },
             ensureHttpTrigger: async () => "unused-here",
             updateFunctionCode: async () => {} },
    bucket: "teamclaw-sync",
    appsBaseUrl: "postgres://host:5432/teamclaw_apps",
    genPassword: () => "pw-fixed",
  };
  const out = await startDeploy(deps as any, {
    appId: "3f1c9a2e-0000-4000-8000-000000000abc", slug: "Demo App", region: "cn-hangzhou",
  });
  assert.equal(out.fcFunctionName, "tc-app-3f1c9a2e-0000-4000-8000-000000000abc");
  assert.equal(out.fcRegion, "cn-hangzhou");
  assert.equal(out.ossObjectName, "apps/3f1c9a2e-0000-4000-8000-000000000abc/code.zip");
  // function ensured with PORT + DATABASE_URL injected
  const [, args] = ensured[0];
  assert.equal(args.env.PORT, "9000");
  assert.match(args.env.DATABASE_URL, /app_3f1c9a2e/);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `services/fc/src/lib/provisioning/app-deploy.ts`:

```typescript
import { randomBytes } from "node:crypto";
import { ensureAppSchema } from "./app-postgres.js";

export interface DeployDeps {
  adminExec: (sql: string) => Promise<void>;     // teamclaw_apps admin executor (M1 getAppsAdminExecutor)
  fcOps: {
    ensureFunction: (name: string, a: { ossObjectName: string; env: Record<string, string> }) => Promise<void>;
    ensureHttpTrigger: (name: string) => Promise<string>;
    updateFunctionCode: (name: string, a: { ossObjectName: string; env: Record<string, string> }) => Promise<void>;
  };
  bucket: string;
  appsBaseUrl: string;        // teamclaw_apps base URL WITHOUT role/password (e.g. postgres://host:5432/teamclaw_apps)
  genPassword?: () => string; // injectable for tests
}

export interface StartDeployInput { appId: string; slug: string; region: string; }
export interface StartDeployResult {
  fcFunctionName: string; fcRegion: string; ossObjectName: string; databaseUrl: string;
}

export function appFunctionName(appId: string): string { return `tc-app-${appId}`; }
export function appOssObjectName(appId: string): string { return `apps/${appId}/code.zip`; }

export async function startDeploy(deps: DeployDeps, input: StartDeployInput): Promise<StartDeployResult> {
  const password = (deps.genPassword ?? (() => randomBytes(18).toString("base64url")))();
  // 1. schema + scoped role (idempotent) → app DATABASE_URL (secret, never persisted)
  const conn = await ensureAppSchema(deps.adminExec, {
    appId: input.appId, slug: input.slug, password, baseUrl: deps.appsBaseUrl,
  });
  const functionName = appFunctionName(input.appId);
  const ossObjectName = appOssObjectName(input.appId);
  // 2. ensure the FC function (env carries PORT + the app's own DATABASE_URL)
  await deps.fcOps.ensureFunction(functionName, {
    ossObjectName,
    env: { PORT: "9000", NODE_ENV: "production", DATABASE_URL: conn.connectionString },
  });
  return { fcFunctionName: functionName, fcRegion: input.region, ossObjectName, databaseUrl: conn.connectionString };
}
```

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `git add services/fc/src/lib/provisioning/app-deploy.ts services/fc/test/provisioning/app-deploy.test.ts && git commit -m "feat(apps): startDeploy orchestration (schema + FC function)"`

> NOTE: the app's `DATABASE_URL` is injected into the FC function env only and returned for that purpose; it is NEVER written to `amux.apps`. The route (Task 5) persists only `fc_function_name`/`fc_region`/`fc_status`.

### Task 4: extend `mapApp` + add `deployApp` to pg-repo

**Files:** Modify `services/fc/src/lib/pg-repo/apps.ts`; Modify `services/fc/test/pg-repo-apps.test.ts`

- [ ] **Step 1: Write the failing test** (extend the existing pglite-backed apps test; reuse its `seedTeam`/`seedActor` helpers). Inject fakes for the deploy deps via the repo factory:

```typescript
test("deployApp moves a ready app to awaiting_build and records fc identity", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  // create an app and force it to provision_status=ready (deploy precondition)
  const repo = createPgBusinessRepository({ db, userId: "u1", callerActorId: actor.id,
    startDeploy: async () => ({ fcFunctionName: "tc-app-x", fcRegion: "cn-hangzhou", ossObjectName: "apps/x/code.zip", databaseUrl: "postgres://app_x:pw@h/teamclaw_apps" }),
  } as any);
  const app = await repo.createApp({ teamId: team.id, name: "Demo", type: "fullstack_tanstack_postgres" });
  await db.update(/* apps */).set({ provisionStatus: "ready" }); // pseudocode — set provision_status=ready via drizzle on apps where id=app.id
  const out = await repo.deployApp(app.id);
  assert.equal(out.fcStatus, "awaiting_build");
  assert.equal(out.fcFunctionName, "tc-app-x");
  assert.equal(out.ossObjectName, "apps/x/code.zip"); // returned to the caller so it can kick the daemon build
});
```
(Use the real drizzle `apps` import already in the test file to set `provisionStatus:"ready"`; write the actual update, not pseudocode.)

- [ ] **Step 2: Run → fail** (`deployApp is not a function`).

- [ ] **Step 3: Implement.** In `apps.ts`:
  1. Extend `mapApp` to also expose `fcEndpoint`, `fcFunctionName`, `fcRegion`:
     ```typescript
     fcStatus: r.fcStatus ?? null,
     fcEndpoint: r.fcEndpoint ?? null,
     fcFunctionName: r.fcFunctionName ?? null,
     fcRegion: r.fcRegion ?? null,
     ```
     and add the same columns to the `listApps` raw SELECT (`fc_endpoint AS "fcEndpoint"`, `fc_function_name AS "fcFunctionName"`, `fc_region AS "fcRegion"`).
  2. Extend `AppsRepoDeps` with the deploy hooks:
     ```typescript
     startDeploy?: (a: { appId: string; slug: string; region: string }) =>
       Promise<{ fcFunctionName: string; fcRegion: string; ossObjectName: string; databaseUrl: string }>;
     finalizeDeploy?: (a: { fcFunctionName: string; ossObjectName: string; databaseUrl?: string }) =>
       Promise<{ fcEndpoint: string }>;
     ```
  3. Add `deployApp(appId)` (creator-gated via `loadVisibleApp` + creator check, exactly like `updateApp`):
     ```typescript
     async deployApp(appId: string) {
       const existing = await loadVisibleApp(appId);
       if (!existing) return null;
       if (ctx.userId) {
         const a = await resolveActorForTeam(db, ctx.userId, existing.teamId);
         if (!a || existing.createdByActorId !== a) return null;
       }
       if (existing.provisionStatus !== "ready") {
         throw new ApiError(409, "app_not_ready", "app must be seeded (provision_status=ready) before deploy");
       }
       if (!deps.startDeploy) throw new ApiError(503, "deploy_unavailable", "deploy provisioning not configured");
       const r = await deps.startDeploy({ appId, slug: existing.slug, region: process.env.REGION || "cn-hangzhou" });
       const [row] = await db.update(apps).set({
         fcFunctionName: r.fcFunctionName, fcRegion: r.fcRegion,
         fcStatus: "awaiting_build", provisionError: null, updatedAt: new Date(),
       }).where(eq(apps.id, appId)).returning();
       return { ...mapApp(row), ossObjectName: r.ossObjectName };
     }
     ```
     On any `deps.startDeploy` throw, catch → set `fcStatus:"deploy_error"`, `provisionError:String(e.message)`, return that row, and rethrow-as-handled? No — write the error row then `throw new ApiError(502, "deploy_failed", msg)` so the route surfaces it. Wrap the `startDeploy` call in try/catch implementing that.

- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Run the apps repo suite** `cd services/fc && node --import tsx --test test/pg-repo-apps.test.ts` → green.
- [ ] **Step 6: Commit** `git add services/fc/src/lib/pg-repo/apps.ts services/fc/test/pg-repo-apps.test.ts && git commit -m "feat(apps): pg-repo deployApp + fc_* in mapApp"`

### Task 5: deploy route + index.ts wiring

**Files:** Modify `services/fc/src/lib/routes/apps.ts`; Modify `services/fc/src/index.ts`; Test `services/fc/test/routes-apps-deploy.test.ts` (new, route-level with a fake repository)

- [ ] **Step 1: Write the failing test** — register the routes against a fake router whose `ctx.repository.deployApp` returns a known shape, assert `POST /v1/apps/:id/deploy` returns `{ fcStatus, ossObjectName }` and 404 when `deployApp` returns null. (Mirror the existing route-test harness used by other `services/fc/test/*route*` tests — inspect one first to match the fake-router shape.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** in `routes/apps.ts` (inside `registerApps`):

```typescript
router.post("/v1/apps/:appId/deploy", async (ctx) => {
  const appId = decodeURIComponent(ctx.params.appId);
  const out = await ctx.repository.deployApp(appId);
  if (!out) throw new ApiError(404, "not_found", "app not found");
  return { statusCode: 202, body: out };
});
```

In `index.ts`, construct the deploy deps once (mirroring `provisionAppRepo`) and pass to BOTH `createPgBusinessRepository` and the supabase repo:

```typescript
import { getAppsAdminExecutor } from "./lib/provisioning/app-postgres.js";
import { getFcClient, makeFcOps } from "./lib/provisioning/fc-client.js";
import { startDeploy as startDeployImpl, finalizeDeploy as finalizeDeployImpl } from "./lib/provisioning/app-deploy.js";

function makeDeployDeps() {
  if (!process.env.APPS_DB_ADMIN_URL || !process.env.ACCESS_KEY_ID) return {}; // unconfigured → routes 503
  const fcOps = makeFcOps(getFcClient(), { bucket: process.env.BUCKET || "teamclaw-sync", role: process.env.ROLE_ARN });
  const adminExec = getAppsAdminExecutor();
  const appsBaseUrl = process.env.APPS_DB_ADMIN_URL!; // role/pw overwritten per-app inside ensureAppSchema
  return {
    startDeploy: (a: { appId: string; slug: string; region: string }) =>
      startDeployImpl({ adminExec, fcOps, bucket: process.env.BUCKET || "teamclaw-sync", appsBaseUrl }, a),
    finalizeDeploy: (a: { fcFunctionName: string; ossObjectName: string; databaseUrl?: string }) =>
      finalizeDeployImpl({ fcOps }, a),
  };
}
```
Spread `...makeDeployDeps()` into both repo constructions next to `provisionAppRepo`.

- [ ] **Step 4: Run → pass.** Then full suite `cd services/fc && pnpm test` (the 10 pre-existing `sync-flow` env failures remain; nothing else red).
- [ ] **Step 5: Commit** `git add services/fc/src/lib/routes/apps.ts services/fc/src/index.ts services/fc/test/routes-apps-deploy.test.ts && git commit -m "feat(apps): POST /v1/apps/:id/deploy route + deploy deps wiring"`

### Task 6: supabase-repo `deployApp` parity + OpenAPI

**Files:** Modify `services/fc/src/lib/supabase-repo.ts`; Modify `docs/openapi/teamclaw-api.v1.yaml`; Test `services/fc/test/supabase-repo.test.ts`

- [ ] **Step 1:** Read the existing apps section of `supabase-repo.ts` (it already implements `createApp`/`updateApp`/`listApps` forwarding caller bearer → RLS). Add `deployApp(appId)` mirroring the pg-repo flow but using the supabase client: load the app (RLS-gated), enforce `provision_status==='ready'`, call the injected `startDeploy`, `update amux.apps` set `fc_function_name/fc_region/fc_status='awaiting_build'`, return `{...mappedApp, ossObjectName}`. Accept the same injected `startDeploy`/`finalizeDeploy` deps the factory passes.

- [ ] **Step 2:** Add a contract test asserting `deployApp` exists and returns the canonical shape (mirror the existing repository-contract test for apps). Run the supabase-repo test file → green (or pre-existing-only failures).

- [ ] **Step 3:** OpenAPI: add `POST /v1/apps/{appId}/deploy` (202 → `{ ...App, ossObjectName }`), and add `fcEndpoint`, `fcFunctionName`, `fcRegion` (nullable strings) to the `App` schema. Run `cd services/fc && pnpm openapi:lint` → clean.

- [ ] **Step 4: Commit** `git add services/fc/src/lib/supabase-repo.ts services/fc/test/supabase-repo.test.ts docs/openapi/teamclaw-api.v1.yaml && git commit -m "feat(apps): supabase-repo deployApp parity + OpenAPI deploy endpoint"`

---

## M3 — Daemon builder + deployable template

### Task 7: Investigate the daemon's OSS upload primitive — DONE (findings below)

**FINDING (architecture correction):** the daemon holds **no OSS credentials**. It uploads bytes by `PUT`-ing to a **presigned URL** it receives from the cloud:
- `apps/daemon/src/sync/oss/fc_client.rs:243` — `pub async fn put_blob(&self, presigned_url: &str, data: Vec<u8>) -> Result<(), SyncError>` (a plain reqwest `PUT` to the URL).
- The cloud mints presigned PUTs in `services/fc/src/lib/sync-handlers.ts` via `@aws-sdk/s3-request-presigner` `getSignedUrl(s3, new PutObjectCommand({Bucket, Key, ContentLength}), {expiresIn: 900})` using the `oss.ts` S3 client.

**Corrected deploy flow (supersedes the M3 sketch in this plan's header diagram):**
1. Desktop `POST /v1/apps/:id/deploy` → FC `deployApp`: `startDeploy` (ensure schema + ensure function) **AND mint a presigned PUT URL** for `apps/<appId>/code.zip` (via the oss S3 client, `ContentLength` omitted or sent by the daemon). Response: `{ ...app, fcStatus:'awaiting_build', ossObjectName, presignedPut }`.
2. Desktop `POST daemon /v1/apps/build` with `{ appId, presignedPut }` → daemon: `pnpm install && pnpm build` → zip `.output` → `put_blob(presignedPut, zip_bytes)`. **No OSS creds on the daemon.**
3. Desktop `POST /v1/apps/:id/deploy/finalize` → FC `finalizeDeploy`: `updateFunctionCode` from the (now-uploaded) fixed OSS object + `ensureHttpTrigger` → `fc_status='live'`, `fc_endpoint`.

**Required M2 follow-up (Task 7b, do BEFORE Task 8):** the completed M2 `deployApp` returns `{...app, ossObjectName}` but NOT `presignedPut`. Add presigned-PUT minting:
- Add a `mintUploadUrl(ossObjectName) => Promise<string>` to the deploy deps (implemented in `services/fc/src/index.ts`'s `makeDeployDeps()` by reusing the `oss.ts` S3 client + `getSignedUrl`/`PutObjectCommand`, mirroring `sync-handlers.ts`).
- `startDeploy` (or `deployApp`) calls it and includes `presignedPut` in the returned/persisted-nowhere response. Extend the route/OpenAPI `deploy` 202 body with `presignedPut: string`. Update both pg-repo and supabase-repo `deployApp` for parity, and the desktop `AppsBackend.deployApp` return type (M5-T13). `presignedPut` is a short-lived secret — return to the client, never persist.

- [x] Investigation complete (recorded above). Task 7b + Tasks 8–9 below adopt the presigned-URL flow.

### Task 8: `app_build` — build, zip, upload

**Files:** Create `apps/daemon/src/sync/app_build.rs`; Modify `apps/daemon/src/sync/mod.rs` (add `pub mod app_build;`); Test: inline `#[cfg(test)]` in `app_build.rs`

- [ ] **Step 1: Write failing unit tests** for the pure, side-effect-free pieces (mirror `app_seed.rs`'s test style): (a) `build_command()` returns `pnpm install && pnpm build` invocation pieces; (b) `oss_object_key(app_id)` == `apps/<appId>/code.zip`; (c) a `zip_dir` helper produces a non-empty archive of a temp `.output` tree. Do NOT unit-test the real OSS upload (network) — gate it behind the injected uploader so tests pass a fake.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `build_app(workdir, app_id, uploader)`:
  - Run `pnpm install` then `pnpm build` in `workdir` (the app checkout seeded by `app_seed`), surfacing stderr on failure (reuse the `run_*`/redact pattern from `app_seed.rs`).
  - Zip `workdir/.output` (the `node-server` output — per runtime spike) into an in-memory/temp `code.zip`. [LIVE-GATE in M4: confirm whether `.output/server/node_modules` must be included — inspect a real build.]
  - Upload the zip bytes by `PUT`-ing to the **presigned URL** passed into the build request (reuse `crate::sync::oss::fc_client`'s `put_blob(presigned_url, bytes)` — the daemon has NO OSS creds). `build_app(workdir, presigned_put: &str)` calls the daemon's reqwest PUT helper; unit tests inject a fake PUT (e.g. an `async fn(url, bytes)` closure / a wiremock) so no network.
  - Return `Ok(())` (the cloud finalize step reads the fixed OSS key `apps/<appId>/code.zip`).

- [ ] **Step 4: Run → pass** (`cargo test --bin amuxd app_build` from `apps/daemon`).
- [ ] **Step 5: Commit** `git add apps/daemon/src/sync/app_build.rs apps/daemon/src/sync/mod.rs && git commit -m "feat(apps): daemon app_build (pnpm build + zip + OSS upload)"`

### Task 9: `POST /v1/apps/build` daemon endpoint

**Files:** Modify `apps/daemon/src/http/apps.rs`; Modify `apps/daemon/src/http/routes.rs`

- [ ] **Step 1: Write failing tests** mirroring `seed_app`'s body tests: a `BuildAppBody` (camelCase: `appId`, `teamId`, optional `workdir`, **required `presignedPut: String`**) deserializes; `resolve_workdir` reuses the same `<amuxd home>/apps/<appId>` default (the seeded checkout must already EXIST for build — unlike seed which requires it absent).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `build_app` handler mirroring `seed_app`: require `workspace:write`; resolve the workdir (must exist); `tokio::task::spawn_blocking` → `crate::sync::app_build::build_app(&workdir, &body.presigned_put)` (build+zip then PUT to the presigned URL — no OSS creds needed). Return `{ "status": "built" }`. Register `.route("/v1/apps/build", post(apps::build_app))` in `routes.rs`. The `presignedPut` is a short-lived secret: never log it (apply the `redact` pattern from `app_seed.rs` if any error includes it).

- [ ] **Step 4: Run → pass** (`cargo test --bin amuxd` apps module). [Do not run the broken integration crate; `--bin amuxd` only, per phase-1 convention.]
- [ ] **Step 5: Commit** `git add apps/daemon/src/http/apps.rs apps/daemon/src/http/routes.rs && git commit -m "feat(apps): daemon POST /v1/apps/build endpoint"`

### Task 10: Make the template FC-deployable

**Files:** Modify `apps/daemon/templates/tanstack-postgres/` (e.g. `app.config.ts`/vite config, `package.json`, a `db` bootstrap, a README)

- [ ] **Step 1:** Read the current template tree (`ls -R apps/daemon/templates/tanstack-postgres`). Confirm it's a TanStack Start app; if minimal, bring it to a buildable `node-server` app.
- [ ] **Step 2:** Set the Nitro/TanStack **`node-server`** preset so `pnpm build` emits `.output/server/index.mjs` (per runtime spike §2). Ensure `package.json` has a `build` script.
- [ ] **Step 3:** DB access reads `process.env.DATABASE_URL` (the per-app scoped connection with pinned `search_path`); add a tiny pooled client. Include ONE example table + an app-owned migration that runs **on boot** (the role owns its schema; provisioner does NOT run app migrations — design §5).
- [ ] **Step 4:** Add a minimal route/loader that reads/writes that table so a live deploy demonstrably serves real data.
- [ ] **Step 5: Verify it builds locally** — in a scratch copy: `pnpm install && pnpm build`, confirm `.output/server/index.mjs` exists and `PORT=9000 node .output/server/index.mjs` listens on 9000/0.0.0.0. Record whether `.output/server/node_modules` exists (feeds Task 8's zip decision).
- [ ] **Step 6: Commit** `git add apps/daemon/templates/tanstack-postgres && git commit -m "feat(apps): make tanstack-postgres template FC-deployable (node-server preset)"`

---

## M4 — Finalize + live deploy gate

### Task 11: `finalizeDeploy` orchestration + repo method + route

**Files:** Modify `app-deploy.ts`, `app-fc-status.ts` usage, `pg-repo/apps.ts`, `supabase-repo.ts`, `routes/apps.ts`, OpenAPI; Tests alongside each.

- [ ] **Step 1 (orchestration):** Add `finalizeDeploy(deps:{fcOps}, {fcFunctionName, ossObjectName})` to `app-deploy.ts`: call `fcOps.updateFunctionCode(fcFunctionName, {ossObjectName, env})` then `fcOps.ensureHttpTrigger(fcFunctionName)` → `{ fcEndpoint }`. (Env on update can be empty/unchanged; the function env was set at startDeploy.) TDD with a fake fcOps. Commit.
- [ ] **Step 2 (repo):** Add `finalizeDeploy(appId, { ossObjectName })` to pg-repo: creator-gated; require `fc_status` ∈ {awaiting_build, building, deploy_error}; set `fc_status='deploying'`; call `deps.finalizeDeploy`; on success set `fc_status='live'`, `fc_endpoint=<url>`; on failure `fc_status='deploy_error'` + `provision_error` then 502. Enforce transitions via `isLegalFcTransition`. TDD on pglite. Commit.
- [ ] **Step 3 (supabase-repo):** Same method, parity. Contract test. Commit.
- [ ] **Step 4 (route + OpenAPI):** `POST /v1/apps/:appId/deploy/finalize` (body `{ ossObjectName }`) → `ctx.repository.finalizeDeploy`; 404/409/502 surfaced. Add to OpenAPI. `pnpm openapi:lint`. Commit.
- [ ] **Step 5: Full FC suite** `cd services/fc && pnpm test` → only pre-existing sync-flow failures.

### Task 12: [LIVE-GATE] Manual end-to-end live deploy verification

> No product code. This gate confirms the spike "verify live" unknowns before the user-facing button ships. Requires operator prerequisites (below) done.

- [ ] **Step 1:** Operator confirms: `teamclaw_apps` DB exists on the target env RDS; `APPS_DB_ADMIN_URL` + `FC_ENDPOINT`/`ALIYUN_ACCOUNT_ID` set in FC env; AK/SK has `fc:*` + `ram:PassRole`; `ROLE_ARN` trusts FC + has `oss:GetObject` on the code bucket (SDK-spike §6).
- [ ] **Step 2:** Create a test app end-to-end (seed → ready), then drive `POST /v1/apps/:id/deploy`, run the daemon build, `POST .../deploy/finalize`, and curl the returned `fc_endpoint`. Confirm: function created with `custom.debian10`; cold start within `timeout`; the page loads and reads/writes its Postgres schema.
- [ ] **Step 3:** Record actual values for each spike "verify-live" item (runtime string accepted, cwd, externalized deps, error-object shape for 404, cold-start time) into `docs/specs/2026-06-14-apps-fc-runtime-spike.md` under a new "## Live results" section, and fix any wrapper/template constants that differed (e.g. runtime string, `args` cwd). Commit those fixes.

---

## M5 — Desktop Deploy UI

### Task 13: types + cloud-api client + daemon build client

**Files:** Modify `packages/app/src/lib/backend/types.ts`, `cloud-api/apps.ts`, `daemon-local-client.ts`

- [ ] **Step 1:** `AppRow`: add `fcEndpoint: string | null;` and `fcFunctionName: string | null;`. `AppsBackend`: add `deployApp(appId: string): Promise<(AppRow & { ossObjectName: string }) | null>;` and `finalizeDeploy(appId: string, ossObjectName: string): Promise<AppRow | null>;`.
- [ ] **Step 2:** `cloud-api/apps.ts`: implement both — `client.post(\`/v1/apps/${id}/deploy\`, {})` and `client.post(\`/v1/apps/${id}/deploy/finalize\`, { ossObjectName })`, each catching 404 → null (mirror `updateAppProvisionStatus`).
- [ ] **Step 3:** `daemon-local-client.ts`: add `buildDaemonApp(appId, teamId)` mirroring `seedDaemonApp` (POST `/v1/apps/build`), returning `"built" | "failed" | "unreachable"`.
- [ ] **Step 4:** Vitest for the cloud-api methods + a typecheck. Commit.

### Task 14: store `deploy(appId)` orchestration

**Files:** Modify `packages/app/src/stores/apps-store.ts`; Modify `apps-store.test.ts`

- [ ] **Step 1: Write failing tests** (mirror existing apps-store tests that mock `getBackend()` + daemon client): `deploy(appId)` calls `deployApp` → on `{fcStatus:'awaiting_build', ossObjectName}` kicks `buildDaemonApp` → on `"built"` calls `finalizeDeploy(appId, ossObjectName)` → patches the row to the `live` result; a daemon `"unreachable"`/`"failed"` leaves `fc_status` non-live and surfaces nothing fatal (the row already shows `awaiting_build`/`deploy_error` from the server).
- [ ] **Step 2: Implement** `deploy` on the store mirroring `runSeed`: optimistic nothing; call sequence with non-fatal try/catch; patch `items` from each server response. Re-use a `patchRow` helper (generalize `patchStatus`).
- [ ] **Step 3: Run → pass.** Commit.

### Task 15: Deploy button + status badge + live link

**Files:** Modify `packages/app/src/components/sidebar/AppsListColumn.tsx`; locales `en.json`/`zh-CN.json`; helper test

- [ ] **Step 1:** Add a **Deploy** action on each app row, enabled only when `provisionStatus==='ready'`; while `fc_status` ∈ {awaiting_build,building,deploying} show a "deploying…" state (disabled); on `live` show the `fcEndpoint` as a clickable external link; on `deploy_error` show a retry affordance. Pure presentational helpers (status→label/enabled) go in a tested helper (mirror `AppsListColumn.helpers.test.ts`).
- [ ] **Step 2:** i18n keys for the new labels in both locales (pass `i18n-parity`; detail subkeys must not collide with group labels — known gotcha).
- [ ] **Step 3:** Run `pnpm --filter @teamclaw/app exec vitest run src/components/sidebar` + `pnpm typecheck` + `pnpm lint`. Commit.

---

## Out of band (operator follow-up — required before M4 live-gate)

- [ ] Create `teamclaw_apps` DB on each env RDS; set `APPS_DB_ADMIN_URL` (FC secret).
- [ ] Set `FC_ENDPOINT` (or `ALIYUN_ACCOUNT_ID`) for the account-scoped FC 3.0 data-plane host.
- [ ] Grant the FC AK/SK `fc:CreateFunction/UpdateFunction/GetFunction/CreateTrigger/GetTrigger` + `ram:PassRole`; ensure `ROLE_ARN` trusts `fc.aliyuncs.com` and has `oss:GetObject` on the code bucket.

---

## Self-Review

- **Spec coverage:** design §3.1 FC client → T2; §3.1 app-postgres reuse → T3; §3.1 routes → T5/T6/T11; §3.2 daemon builder → T7–T9; §3.3 template → T10; §3.4 desktop → T13–T15; §4 state machine → T1 (+ enforced in T4/T11); §5 security (DATABASE_URL FC-env-only, never persisted) → T3 note + T4/T11; §6 testing → per-task; §7 spikes → consumed (T2/T10) + live-gate T12.
- **Placeholder scan:** code-bearing steps show code or name the exact existing pattern to mirror with the file already read (`app_seed.rs`, `seedDaemonApp`, `updateApp`, `app-status.ts`). T4 Step-1 contains one explicitly-labeled pseudocode line (the drizzle `provisionStatus:"ready"` update) the implementer must write concretely — flagged, not hidden. T7/T10-Step1 are investigation steps with concrete deliverables, not vague TODOs.
- **Type consistency:** `startDeploy`/`finalizeDeploy`/`StartDeployResult`/`makeFcOps`/`ensureFunction`/`ensureHttpTrigger`/`isLegalFcTransition`/`deployApp`/`finalizeDeploy`/`ossObjectName`/`fcEndpoint`/`fcFunctionName`/`fcRegion` are used consistently across FC, repo, route, and desktop tasks.
- **Live-gated honesty:** FC behaviors that cannot be unit-verified are isolated in the wrapper, unit-tested via fakes, and confirmed at the single M4 live-gate (T12) before the M5 button ships — not asserted as done.
- **Decomposition note:** M2 (control plane) and M3 (daemon+template) are independently testable; M5 depends on M2/M4 route shapes. If executing incrementally, M2→M3→M4(live-gate)→M5 is the required order (M4 may force wrapper/template constant fixes that M5 should build on).
