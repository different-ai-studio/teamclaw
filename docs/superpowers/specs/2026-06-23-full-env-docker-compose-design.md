# Full self-host environment via a single docker compose

**Date:** 2026-06-23
**Status:** Approved design
**Scope:** new `deploy/self-host/` directory (orchestration only). No changes to
`services/fc/` source, `services/fc/docker-compose.yml`, `deploy/docker-compose.yml`,
`s.yaml`, or any deploy workflow.

## Goal

One `docker compose up` stands up a complete, deployable TeamClaw backend
environment: a self-hosted Supabase stack, an EMQX MQTT broker, the FC Cloud API,
edge TLS via Caddy, and an automatic DB migration/seed step. The standalone
Postgres backend (`BACKEND_KIND=postgres`) is opt-in via a compose profile;
everything else is required.

Target is a **deployable self-host** (real server with public domains), while the
same compose file also works locally (Caddy `tls internal` / http fallback).

## Background

- FC is already containerized: `services/fc/Dockerfile` + `src/server.ts`
  (`@hono/node-server`) serve `createApp(deps)` on `:9000`, with `GET /healthz`
  and a secret-guarded `POST /internal/cron` (tasks `oss-abandon-sessions`,
  `oss-gc-blobs`). See `docs/superpowers/specs/2026-06-23-fc-docker-self-host-design.md`.
- FC config is fully env-driven (authoritative list in `services/fc/s.yaml`):
  `SUPABASE_URL`, `SUPABASE_PUBLIC_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `BACKEND_KIND` (default `supabase`),
  `DATABASE_URL` (postgres backend), OSS (`ACCESS_KEY_ID/SECRET`, `ROLE_ARN`,
  `BUCKET`, `REGION`, `ENDPOINT`), MQTT (`MQTT_BROKER_URL`, `MQTT_USERNAME`,
  `MQTT_PASSWORD`, `MQTT_USE_TLS`), LiteLLM, APNs, `CRON_TRIGGER_SECRET`.
- FC connects to MQTT as a **publisher** using `MQTT_USERNAME`/`MQTT_PASSWORD`
  (`src/lib/push-deps.ts`, `mqtt-client.ts`); it tolerates an unset broker
  (push degrades, service still boots). Clients (desktop/daemon) authenticate to
  EMQX with a **Supabase JWT** (HS256 / HMAC, base64-encoded secret) — the
  production EMQX auth model.
- Supabase migrations live in `services/supabase/migrations/*.sql` (timestamped
  CLI-style) plus `services/supabase/seed.sql`. They reference the `auth` schema
  (`auth.users`), which only exists after GoTrue first initializes.
- OSS is Alibaba Cloud object storage; there is no in-cluster equivalent.

## Non-goals (YAGNI)

- No bundled object storage (no MinIO). OSS stays external via `.env`.
- No native MQTTS (8883) TCP listener — clients use WSS over 443 only.
- No in-container scheduler beyond a thin cron sidecar that curls
  `/internal/cron`.
- No change to FC source, the Lambda `handler`/FC deploy path, or existing
  compose files.
- No new business endpoints or schema changes.

## Architecture

New directory, self-contained:

```
deploy/self-host/
  docker-compose.yml        # top-level orchestration
  .env.example              # single source for all secrets/domains/ports
  README.md                 # one-shot bring-up + troubleshooting
  bootstrap/
    gen-secrets.sh          # derive ANON_KEY / SERVICE_ROLE_KEY / MQTT_SERVICE_TOKEN from one JWT_SECRET
  supabase/                 # vendored from official supabase/docker
    volumes/...             # kong.yml, db init, etc.
  emqx/
    emqx.conf               # single JWT (HMAC, base64) authenticator
  caddy/
    Caddyfile               # edge TLS + reverse proxy (env-templated domains)
  init/
    apply-migrations.sh     # idempotent migrations + seed runner
```

### Services

| service | role | published | required |
|---|---|---|---|
| `supabase-db` | Postgres 15 (Supabase) | — (internal) | ✅ |
| `auth` | GoTrue | — | ✅ |
| `rest` | PostgREST | — | ✅ |
| `realtime` | Realtime | — | ✅ |
| `storage` + `imgproxy` | Storage API | — | ✅ |
| `meta` | postgres-meta | — | ✅ |
| `kong` | Supabase API gateway (= `SUPABASE_URL` :8000) | — | ✅ |
| `studio` | Supabase Studio | via Caddy (optional domain) | ✅ |
| `emqx` | MQTT broker (JWT authn) | — (1883/8083 internal) | ✅ |
| `fc` | TeamClaw Cloud API (`build: ../../services/fc`) | — | ✅ |
| `caddy` | edge TLS + reverse proxy | **80, 443** | ✅ |
| `migrate` | one-shot: apply migrations + seed | — | ✅ |
| `cron` | thin sidecar: periodic `POST /internal/cron` | — | profile `cron` |
| `postgres` | standalone backend for `BACKEND_KIND=postgres` | — | profile `postgres` |

Only `caddy` publishes host ports (80/443). Everything else communicates on the
internal compose network; admin UIs (Studio, EMQX dashboard) are reached through
Caddy on optional domains or left internal.

### Caddy (edge TLS)

- Sole public ingress on 80/443. Automatic Let's Encrypt issuance + renewal;
  certs persisted in a `caddy_data` volume (survives restarts).
- `Caddyfile` reverse proxies, domains from `.env`:
  - `{$FC_DOMAIN}` → `fc:9000` (Cloud API)
  - `{$SUPABASE_DOMAIN}` → `kong:8000` (→ `SUPABASE_PUBLIC_URL`)
  - `{$MQTT_DOMAIN}` → `emqx:8083` (WSS upgrade → EMQX WS listener `/mqtt`;
    Caddy v2 `reverse_proxy` proxies WebSocket upgrades transparently)
  - optional `{$STUDIO_DOMAIN}` / `{$EMQX_DASHBOARD_DOMAIN}`
- Local/no-domain mode: a `.env` toggle switches Caddy to `tls internal` (local
  CA) or plain http, so one compose file serves both local and server use.

### Internal vs public URLs (critical)

- FC → dependencies use plaintext internal addresses:
  `SUPABASE_URL=http://kong:8000`, `MQTT_BROKER_URL=mqtt://emqx:1883`.
- Client-facing values are public TLS:
  `SUPABASE_PUBLIC_URL=https://{SUPABASE_DOMAIN}`; `/v1/config` advertises MQTT
  as `wss://{MQTT_DOMAIN}/mqtt` with `MQTT_USE_TLS=true`.

### EMQX authentication — single JWT authenticator

- One JWT authenticator: `mechanism=jwt`, `algorithm=hmac-based`, HS256,
  `secret={JWT_SECRET}`, `secret_base64_encoded=true` — matches production and
  the Supabase HMAC secret. Clients pass their Supabase JWT as the MQTT password.
- FC also authenticates with a JWT: `bootstrap/gen-secrets.sh` mints a long-lived
  service JWT (HS256, signed with `JWT_SECRET`, e.g. `sub=fc-service`) into
  `MQTT_SERVICE_TOKEN`; the compose sets FC's `MQTT_PASSWORD=${MQTT_SERVICE_TOKEN}`
  (username arbitrary). No second authenticator / built-in password DB needed.
- ACL/authorization is left at EMQX defaults (allow) for this scope; topic-level
  authz is out of scope.

### Secret derivation — one `JWT_SECRET`

Self-hosted Supabase already requires `ANON_KEY` and `SERVICE_ROLE_KEY` to be
JWTs signed by `JWT_SECRET`. `bootstrap/gen-secrets.sh` generates, from a single
operator-provided `JWT_SECRET`:

- `ANON_KEY`, `SERVICE_ROLE_KEY` (standard Supabase role JWTs)
- `MQTT_SERVICE_TOKEN` (FC's MQTT credential)

It writes/updates them into `.env`. Run once before `docker compose up`.
`.env.example` documents every var; `.env` is gitignored.

### migrate — ordering & idempotency

- One-shot container. `depends_on`: `supabase-db` **and** `auth` both
  `service_healthy` (migrations reference `auth.users`; the `auth` schema exists
  only after GoTrue's first run).
- `init/apply-migrations.sh` connects as the Postgres superuser (internal
  `POSTGRES_PASSWORD`), applies `services/supabase/migrations/*.sql` in filename
  (timestamp) order, then `seed.sql`.
- A `schema_migrations` marker table records applied filenames; already-applied
  files are skipped — safe to re-run on every `up`.
- `services/supabase` is mounted (read-only) into the container, or the files are
  copied in at build; mount preferred so no rebuild on migration changes.

### Optional Postgres backend (`profile: postgres`)

- Standalone `postgres` service, only started with
  `docker compose --profile postgres up`.
- When used, operator sets `BACKEND_KIND=postgres` and `DATABASE_URL` pointing at
  `postgres:5432`. Default (no profile) keeps `BACKEND_KIND=supabase` and the
  service is absent.

### cron sidecar (`profile: cron`)

- Thin container (shell loop / `curl`) that periodically POSTs to
  `http://fc:9000/internal/cron` with header `x-cron-secret: ${CRON_TRIGGER_SECRET}`
  for `oss-abandon-sessions` (every 15 min) and `oss-gc-blobs` (daily), mirroring
  the FC timer triggers in `s.yaml`. Opt-in so the core stack stays lean.

## Data flow

```
Client ──HTTPS──▶ Caddy(443) ──▶ kong:8000 (Supabase) / fc:9000 (Cloud API)
Client ──WSS────▶ Caddy(443) ──▶ emqx:8083 /mqtt   (JWT = Supabase token)
FC ─────────────▶ kong:8000 (http) , emqx:1883 (mqtt, MQTT_SERVICE_TOKEN)
migrate ────────▶ supabase-db (psql: migrations/*.sql → seed.sql, idempotent)
cron ───────────▶ fc:9000 POST /internal/cron (x-cron-secret)
FC ─────────────▶ external Alibaba OSS (.env credentials)
```

## Error handling

- `gen-secrets.sh`: missing `JWT_SECRET` → clear error, non-zero exit before any
  service starts.
- `migrate`: any `.sql` failure aborts the run with the offending filename and a
  non-zero exit (visible failure, not silent partial apply); already-applied files
  are skipped via the marker table.
- `fc`: unset MQTT broker degrades push but the service still boots; unset OSS
  degrades team file sync only.
- Caddy: with real domains + reachable 80/443 it auto-provisions certs; in local
  mode it falls back to `tls internal`/http per the `.env` toggle.

## Testing

- `gen-secrets.sh`: verify generated `ANON_KEY`/`SERVICE_ROLE_KEY` verify against
  `JWT_SECRET`, and `MQTT_SERVICE_TOKEN` is accepted by EMQX.
- Bring-up smoke (documented in README, manual):
  1. `bootstrap/gen-secrets.sh` then `docker compose up -d`.
  2. `migrate` completes; re-running `up` does not re-apply migrations.
  3. `GET https://{FC_DOMAIN}/healthz` → 200; a `/v1` route works against the
     Supabase backend.
  4. A WSS client connects to `wss://{MQTT_DOMAIN}/mqtt` with a Supabase JWT;
     FC publishes (e.g. an inbox push) and the client receives it.
  5. `--profile postgres` with `BACKEND_KIND=postgres` boots FC against the
     standalone Postgres.
- No automated FC code changes, so existing FC tests are unaffected.

## Acceptance criteria

1. A single `docker compose up` (after `gen-secrets.sh`) starts Supabase, EMQX,
   FC, Caddy, and runs `migrate`, on one network with Caddy as the only public
   ingress.
2. Migrations + seed apply automatically and idempotently.
3. FC serves over HTTPS at `{$FC_DOMAIN}`; Supabase reachable at
   `{$SUPABASE_DOMAIN}`; WSS MQTT works at `wss://{$MQTT_DOMAIN}/mqtt` with a
   Supabase JWT.
4. EMQX uses a single HMAC/JWT authenticator keyed by `JWT_SECRET`; FC connects
   with a derived service JWT.
5. `--profile postgres` provides the alternative `BACKEND_KIND=postgres` backend;
   `--profile cron` provides scheduled `/internal/cron` invocation. Neither runs
   by default.
6. OSS stays external (env-driven); no FC source or existing compose/deploy files
   are modified.
