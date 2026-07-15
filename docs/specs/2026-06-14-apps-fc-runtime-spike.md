# Spike: TanStack Start (Node SSR) on Alibaba FC 3.0 custom runtime

Status: M0 research spike (no implementation). Sibling spike
`2026-06-14-apps-alicloud-fc-sdk-spike.md` covers the `@alicloud/fc20230330` SDK
calls (CreateFunction / UpdateFunction / CreateTrigger, `customRuntimeConfig`,
code-from-OSS, reading `urlInternet`). This doc covers the **runtime contract**:
how a long-running Node HTTP server runs under FC 3.0 custom runtime and how
TanStack Start's Node output maps onto it. Anything not confirmable from docs is
labeled **to verify live**.

---

## 1. FC 3.0 custom-runtime HTTP contract

FC 3.0 custom runtime (`runtime: "custom.debian10"`) treats your code package as
**an HTTP server program that takes over all requests from Function Compute**.
There is no per-invocation handler dispatch — FC starts your process once per
instance and proxies HTTP traffic to it.

### Startup command + port
- `customRuntimeConfig.command` (+ `args`) is the **Startup Command** FC runs on
  cold start to launch your HTTP server. For Node this is e.g.
  `command: ["node"], args: [".output/server/index.mjs"]` (or the whole thing in
  `command`).
- `customRuntimeConfig.port` is the **Listening Port** ("CAPort"). The server in
  your code **must** listen on exactly this port.
- **Default port is `9000`** if `port` is unset. If you set `port` (e.g. 9000),
  the in-code listener must match it.
- The server **must bind `0.0.0.0` (or `*`)** — `127.0.0.1`/`localhost` will not
  receive FC's proxied traffic and the function will fail health/readiness.

### Request lifecycle
- **Cold start**: FC provisions an instance, runs the Startup Command, then waits
  for the HTTP server to be listening on `port` before routing the first request.
  The runtime is `debian10` with **Node 20** preinstalled (also Python 3.10,
  OpenJDK JRE 21). The cold-start window is bounded by the function `timeout`
  (1–86400s, default 3s — set higher, e.g. 60s, for SSR). **Actual cold-start
  latency for a TanStack bundle is to verify live.**
- **Warm reuse**: once started, the instance is reused for subsequent requests;
  the process stays alive between invocations. Long-lived state (DB connection
  pools, HTTP keep-alive) survives across requests on a warm instance — good for
  the app's Postgres pool. Still handle reconnects defensively.
- **Request passthrough**: FC forwards the public HTTP request to the listening
  server with **method, path, query, headers, and body preserved** (it is a
  transparent HTTP proxy for custom runtime, not the event-envelope model of
  language runtimes). So TanStack routes/loaders/server fns see the real request.
- **Readiness / initializer**: an explicit `/initialize` hook is **optional** for
  custom runtime (it runs once per instance, before the first request, if
  configured). For a plain TanStack node server we do **not** need it — FC's
  readiness gate is simply "is the port listening". Health check is configurable
  via `customRuntimeConfig.healthCheckConfig` but is optional; default behavior
  (port-listening = ready) is sufficient for v1. **to verify live.**

### Invoke URL as `fc_endpoint`
- The HTTP trigger's `urlInternet` (read via
  `getTrigger(fn, "http").body.httpTrigger.urlInternet`, per sibling spike) is a
  fully-qualified public URL (e.g. `https://<svc-fn>.<region>.fcapp.run`). It is
  **suitable as the app's `fc_endpoint` for v1** — no custom domain required.
  Custom domains are a later enhancement (branding / stable hostnames). With
  `authType: "anonymous"` the URL is publicly reachable without request signing.

---

## 2. TanStack Start Node output → command / port / env

TanStack Start builds on **Nitro**. Selecting the standalone Node server preset
produces a ready-to-run server bundle.

### Preset + output
- **Preset: `node-server`** (set in `app.config.ts` / vite config, or
  `--preset node-server` at build). This is the "plain standalone Node server"
  target.
- **Output dir**: `.output/`
  - **Server entry**: `.output/server/index.mjs`  ← the file we run.
  - Client assets bundled under `.output/public/` (served by the same node
    server in node-server preset).
- Run command: `node .output/server/index.mjs`.

### Port
- The Nitro node-server listens on **`PORT` env var, defaulting to `3000`**.
  It honors `PORT` (also `HOST`, default `0.0.0.0` — already FC-compatible).
- **Alignment rule for M3**: set `customRuntimeConfig.port = 9000` AND inject
  `environmentVariables.PORT = "9000"` so the TanStack listener and FC's expected
  port match. (Equivalently leave both at FC's default 9000 and force `PORT=9000`
  — do not rely on Nitro's 3000 default.) HOST defaults to `0.0.0.0`, which
  satisfies FC's bind requirement; no override needed but harmless to set.

### Runtime env the app needs
- `PORT` — must equal `customRuntimeConfig.port` (e.g. `9000`).
- `DATABASE_URL` — the app's per-app Postgres connection string (its own schema;
  this is the runtime/app-scoped credential, distinct from the
  `APPS_DB_ADMIN_URL` used by the provisioner to run `ensureAppSchema`).
- `NODE_ENV=production`.
- Any app-specific config injected via `environmentVariables` on the function.
- Note: only `VITE_`-prefixed vars reach client code; server-only secrets
  (`DATABASE_URL`) stay server-side, which matches FC `environmentVariables`.

---

## 3. Recommended artifact zip layout for M3

The custom runtime expects a **self-contained code package**: the entry plus all
its `node_modules`, because FC's debian10 image has Node 20 but **not your app's
dependencies**. Build with the `node-server` preset, then zip the `.output` tree
together with the install of production deps that the bundle imports.

Nitro's node-server output is largely self-contained (it bundles app code), but
verify whether any deps are left external (`.output/server/node_modules`). Two
viable layouts:

**Option A — run the entry directly via `command` (preferred, simplest):**

```
code.zip
├── .output/
│   ├── server/
│   │   ├── index.mjs            # entry FC starts
│   │   └── node_modules/...     # any externalized deps Nitro kept
│   └── public/...               # client assets
```
- `customRuntimeConfig.command = ["node"]`,
  `args = [".output/server/index.mjs"]`
- `customRuntimeConfig.port = 9000`, `environmentVariables.PORT = "9000"`
- No `bootstrap` file needed — `command` points straight at node.

**Option B — thin `bootstrap` wrapper (use only if a launcher/PATH tweak is needed):**

```
code.zip
├── bootstrap                    # executable shell shim
├── .output/...
```
```sh
#!/bin/bash
# bootstrap (chmod +x). FC runs this if command is left at the default.
export PORT="${PORT:-9000}"
exec node /code/.output/server/index.mjs
```
- FC's legacy default Startup Command for custom runtime is an executable named
  `bootstrap` at the package root. With FC 3.0 you can instead set `command`
  explicitly (Option A) and skip the shim. The code package is unzipped to
  `/code` in the instance, so use absolute `/code/.output/...` inside bootstrap.
- Prefer **Option A** unless live testing shows we need PATH/env setup or a
  wrapper (e.g. to run migrations on boot — which we do NOT want here; schema
  creation is provisioner-side).

Working dir / paths: FC unpacks the zip to `/code` and the process cwd is
typically `/code`. Using a relative `.output/server/index.mjs` in `args` assumes
cwd=`/code` — **to verify live**; absolute `/code/...` is the safe form.

---

## 4. Open questions — verify live in M2/M3

1. **Cold-start latency** of a real TanStack `.output` bundle on `custom.debian10`
   (sets the function `timeout` floor; default 3s is too low — start at 60s).
2. **cwd at startup** — confirm cwd is `/code` so relative `args` work, else use
   absolute `/code/.output/server/index.mjs`.
3. **Externalized deps** — confirm whether Nitro's node-server output bundles
   everything or leaves a `.output/server/node_modules` we must include in the
   zip. Build once and inspect.
4. **bootstrap vs command** — confirm FC 3.0 accepts `command` pointing directly
   at `node` with no `bootstrap` file (Option A). Fall back to Option B if it
   insists on a root `bootstrap`.
5. **Health/readiness** — confirm port-listening alone gates readiness (no
   `healthCheckConfig` / `/initialize` required) for the SSR server.
6. **PORT precedence** — confirm Nitro honors `PORT` over its 3000 default at
   runtime (docs indicate yes); the explicit `PORT=9000` env makes this moot but
   verify the server actually binds 9000.
7. **Request size / streaming** — confirm SSR streaming responses pass through
   the FC HTTP proxy without buffering issues, and check body-size limits.

---

## Sources
- Alibaba Cloud — Custom runtime principles / HTTP server + port 9000 + 0.0.0.0
  bind: https://www.alibabacloud.com/help/en/function-compute/latest/custom-runtime-basic-principle
- Alibaba Cloud — Custom runtime troubleshooting (listening port / bind):
  https://www.alibabacloud.com/help/en/fc/user-guide/troubleshooting
- Alibaba Cloud — Function instance lifecycle (cold start, warm reuse,
  initializer once-per-instance):
  https://www.alibabacloud.com/help/en/functioncompute/fc-2-0/user-guide/function-instance-lifecycle
- Alibaba Cloud — Lifecycle hooks for custom runtime:
  https://www.alibabacloud.com/help/en/functioncompute/fc/user-guide/lifecycle-hooks-for-function-instances-6-1
- TanStack Start — Hosting / deployment presets (node-server, Nitro `.output`):
  https://tanstack.com/start/latest/docs/framework/react/guide/hosting
- TanStack Start — Environment variables (VITE_ prefix, server env):
  https://tanstack.com/start/latest/docs/framework/react/guide/environment-variables
- TanStack Start production port config (PORT / default 3000):
  https://www.answeroverflow.com/m/1413006928803790950
- Railway TanStack Start guide (`node .output/server/index.mjs`, --env-file):
  https://docs.railway.com/guides/tanstack-start
