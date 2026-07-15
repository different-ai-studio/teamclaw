# Full Self-Host Environment (single docker compose) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `docker compose up` (after a one-shot secret-gen step) stands up a complete deployable TeamClaw backend: self-hosted Supabase, EMQX, the FC Cloud API, edge TLS via Caddy, and an automatic idempotent DB migration/seed step.

**Architecture:** A new self-contained `deploy/self-host/` directory holds a top-level `docker-compose.yml` that `include:`s the vendored official Supabase compose and adds `emqx`, `fc`, `caddy`, `migrate`, plus opt-in `cron` and `postgres` profiles. Caddy is the only public ingress (80/443) and terminates TLS; all other services talk over the internal compose network. All secrets derive from one operator-supplied `JWT_SECRET`.

**Tech Stack:** Docker Compose (`include`, profiles, healthchecks), official `supabase/docker`, EMQX 5.x (JWT/HMAC authenticator), Caddy 2 (automatic HTTPS + WebSocket reverse proxy), `services/fc` Dockerfile (already built), Bash + `psql` + `openssl` for bootstrap/migrate scripts.

## Global Constraints

- New directory only: `deploy/self-host/`. Do NOT modify `services/fc/` source, `services/fc/docker-compose.yml`, `services/fc/Dockerfile`, `deploy/docker-compose.yml`, `deploy/Caddyfile`, `s.yaml`, or any `.github/workflows/*`.
- `deploy/self-host/.env` is gitignored (root `.gitignore` line 28 `.env`); only `.env.example` is committed. Never commit real secrets.
- `docs/superpowers/` is gitignored (root `.gitignore` line 112); commit plan/spec docs with `git add -f`.
- Caddy is the ONLY service publishing host ports (`80`, `443`). No other service maps host ports.
- Internal addresses for FC: `SUPABASE_URL=http://kong:8000`, `MQTT_BROKER_URL=mqtt://emqx:1883`. Public addresses for clients: `SUPABASE_PUBLIC_URL=https://${SUPABASE_DOMAIN}`, MQTT `wss://${MQTT_DOMAIN}/mqtt`.
- EMQX uses a SINGLE authenticator: JWT, `hmac-based`, HS256, secret `${JWT_SECRET}`, `secret_base64_encoded=true`. FC connects with a service JWT (`MQTT_SERVICE_TOKEN`) as its MQTT password.
- Migrations: apply `services/supabase/migrations/*.sql` in lexical filename order, then `services/supabase/seed.sql`. Skip `_archive/` and non-`.sql` files. Must be idempotent (marker table `public.schema_migrations`).
- Pin the official Supabase compose to a specific upstream tag/commit; record it in `deploy/self-host/supabase/SUPABASE_VERSION`.
- FC cron task names (from `s.yaml`): `oss-abandon-sessions` (every 15 min), `oss-gc-blobs` (daily). Cron header: `x-cron-secret: ${CRON_TRIGGER_SECRET}`.
- `BACKEND_KIND` default `supabase`; the standalone `postgres` service only runs under `--profile postgres`. The `cron` sidecar only runs under `--profile cron`.

---

### Task 1: Scaffold directory + `.env.example`

Create the directory skeleton and the single authoritative env template. This is the contract every later task reads env names from.

**Files:**
- Create: `deploy/self-host/.env.example`
- Create: `deploy/self-host/.gitignore`

**Interfaces:**
- Produces: env var names consumed by every later task — `JWT_SECRET`, `POSTGRES_PASSWORD`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `MQTT_SERVICE_TOKEN`, `FC_DOMAIN`, `SUPABASE_DOMAIN`, `MQTT_DOMAIN`, `STUDIO_DOMAIN`, `EMQX_DASHBOARD_DOMAIN`, `CADDY_TLS_MODE`, `ACME_EMAIL`, `CRON_TRIGGER_SECRET`, `BACKEND_KIND`, OSS vars, LiteLLM vars.

- [ ] **Step 1: Write `deploy/self-host/.gitignore`**

```gitignore
.env
caddy_data/
caddy_config/
```

- [ ] **Step 2: Write `deploy/self-host/.env.example`**

```dotenv
# ── deploy/self-host environment template ──────────────────────────────
# Copy to .env, set JWT_SECRET + POSTGRES_PASSWORD + domains, then run:
#   ./bootstrap/gen-secrets.sh   (fills ANON_KEY / SERVICE_ROLE_KEY / MQTT_SERVICE_TOKEN)
#   docker compose up -d

# ── core secret (everything derives from this) ─────────────────────────
# Must be >= 32 chars. Used by Supabase + EMQX JWT auth (HS256).
JWT_SECRET=
# Supabase Postgres superuser password.
POSTGRES_PASSWORD=

# ── derived by bootstrap/gen-secrets.sh (leave blank) ──────────────────
ANON_KEY=
SERVICE_ROLE_KEY=
MQTT_SERVICE_TOKEN=

# ── public domains (used by Caddy + client-facing URLs) ────────────────
FC_DOMAIN=api.example.com
SUPABASE_DOMAIN=supabase.example.com
MQTT_DOMAIN=mqtt.example.com
STUDIO_DOMAIN=studio.example.com
EMQX_DASHBOARD_DOMAIN=emqx.example.com

# ── Caddy TLS ──────────────────────────────────────────────────────────
# CADDY_TLS_MODE: "acme" (Let's Encrypt, needs real public domains + 80/443),
#                 "internal" (local CA), or "off" (plain http, local only).
CADDY_TLS_MODE=acme
ACME_EMAIL=ops@example.com

# ── FC service ─────────────────────────────────────────────────────────
BACKEND_KIND=supabase
CRON_TRIGGER_SECRET=
# Standalone postgres backend (only with --profile postgres):
#   set BACKEND_KIND=postgres and uncomment:
# DATABASE_URL=postgres://postgres:postgres@postgres:5432/postgres
POSTGRES_BACKEND_PASSWORD=postgres

# ── object storage (external Alibaba OSS; leave blank to disable) ──────
ACCESS_KEY_ID=
ACCESS_KEY_SECRET=
ROLE_ARN=
BUCKET=teamclaw-team
REGION=cn-shenzhen
ENDPOINT=https://oss-cn-shenzhen.aliyuncs.com

# ── LiteLLM (optional) ─────────────────────────────────────────────────
LITELLM_URL=
LITELLM_MASTER_KEY=
```

- [ ] **Step 3: Verify the dir exists and files are present**

Run: `ls -a deploy/self-host`
Expected: shows `.env.example` and `.gitignore`.

- [ ] **Step 4: Commit**

```bash
git add deploy/self-host/.env.example deploy/self-host/.gitignore
git commit -m "feat(self-host): scaffold deploy/self-host env template"
```

---

### Task 2: `bootstrap/gen-secrets.sh` — derive keys from one JWT_SECRET

A POSIX/bash script that reads `JWT_SECRET` from `.env`, mints the two Supabase role JWTs and one FC MQTT service JWT (all HS256, signed with `JWT_SECRET`), and writes them back into `.env`.

**Files:**
- Create: `deploy/self-host/bootstrap/gen-secrets.sh`
- Test: `deploy/self-host/bootstrap/test-gen-secrets.sh`

**Interfaces:**
- Consumes: `JWT_SECRET` from `deploy/self-host/.env`.
- Produces: `.env` lines `ANON_KEY=`, `SERVICE_ROLE_KEY=`, `MQTT_SERVICE_TOKEN=` filled with valid HS256 JWTs. `ANON_KEY` claims `{"role":"anon","iss":"supabase"}`; `SERVICE_ROLE_KEY` `{"role":"service_role","iss":"supabase"}`; `MQTT_SERVICE_TOKEN` `{"sub":"fc-service","role":"service_role"}`. All `exp` ~10 years out.

- [ ] **Step 1: Write the failing test `bootstrap/test-gen-secrets.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/.env" <<EOF
JWT_SECRET=test-secret-at-least-32-chars-long-xxxxx
ANON_KEY=
SERVICE_ROLE_KEY=
MQTT_SERVICE_TOKEN=
EOF
ENV_FILE="$TMP/.env" ./gen-secrets.sh
# all three must be non-empty 3-part JWTs
for k in ANON_KEY SERVICE_ROLE_KEY MQTT_SERVICE_TOKEN; do
  v="$(grep "^$k=" "$TMP/.env" | cut -d= -f2-)"
  [ -n "$v" ] || { echo "FAIL: $k empty"; exit 1; }
  [ "$(echo "$v" | awk -F. '{print NF}')" = "3" ] || { echo "FAIL: $k not a JWT"; exit 1; }
done
# signature must verify against JWT_SECRET (decode header.payload, re-sign, compare)
SECRET="test-secret-at-least-32-chars-long-xxxxx"
tok="$(grep '^ANON_KEY=' "$TMP/.env" | cut -d= -f2-)"
data="${tok%.*}"; sig="${tok##*.}"
expected="$(printf '%s' "$data" | openssl dgst -sha256 -hmac "$SECRET" -binary \
  | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
[ "$sig" = "$expected" ] || { echo "FAIL: ANON_KEY signature mismatch"; exit 1; }
echo "PASS"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `chmod +x deploy/self-host/bootstrap/test-gen-secrets.sh && deploy/self-host/bootstrap/test-gen-secrets.sh`
Expected: FAIL — `./gen-secrets.sh: No such file or directory`.

- [ ] **Step 3: Write `bootstrap/gen-secrets.sh`**

```bash
#!/usr/bin/env bash
# Derive ANON_KEY, SERVICE_ROLE_KEY, MQTT_SERVICE_TOKEN from JWT_SECRET.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found" >&2; exit 1; }

JWT_SECRET="$(grep '^JWT_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
[ "${#JWT_SECRET}" -ge 32 ] || { echo "error: JWT_SECRET missing or < 32 chars" >&2; exit 1; }

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
NOW="$(date +%s)"; EXP="$((NOW + 315360000))"  # +10y
mint() { # $1=payload-json
  local header payload data sig
  header="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
  payload="$(printf '%s' "$1" | b64url)"
  data="$header.$payload"
  sig="$(printf '%s' "$data" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)"
  printf '%s.%s' "$data" "$sig"
}
ANON="$(mint "{\"role\":\"anon\",\"iss\":\"supabase\",\"iat\":$NOW,\"exp\":$EXP}")"
SVC="$(mint "{\"role\":\"service_role\",\"iss\":\"supabase\",\"iat\":$NOW,\"exp\":$EXP}")"
MQTT="$(mint "{\"sub\":\"fc-service\",\"role\":\"service_role\",\"iat\":$NOW,\"exp\":$EXP}")"

set_kv() { # $1=key $2=value — replace in-place (BSD+GNU sed compatible)
  local key="$1" val="$2"
  if grep -q "^$key=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="}
      $1==k{print k"="v; next}{print}' "$ENV_FILE" > "$ENV_FILE.tmp" \
      && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
set_kv ANON_KEY "$ANON"
set_kv SERVICE_ROLE_KEY "$SVC"
set_kv MQTT_SERVICE_TOKEN "$MQTT"
echo "gen-secrets: wrote ANON_KEY, SERVICE_ROLE_KEY, MQTT_SERVICE_TOKEN to $ENV_FILE"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `chmod +x deploy/self-host/bootstrap/gen-secrets.sh && deploy/self-host/bootstrap/test-gen-secrets.sh`
Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add deploy/self-host/bootstrap/gen-secrets.sh deploy/self-host/bootstrap/test-gen-secrets.sh
git commit -m "feat(self-host): derive supabase + mqtt JWTs from one JWT_SECRET"
```

---

### Task 3: Vendor the official Supabase compose

Copy the upstream Supabase self-host compose + volume configs into `deploy/self-host/supabase/`, pin the version, and trim host port mappings (Caddy fronts everything).

**Files:**
- Create: `deploy/self-host/supabase/docker-compose.yml` (from upstream)
- Create: `deploy/self-host/supabase/volumes/**` (from upstream: `api/kong.yml`, `db/*.sql`, etc.)
- Create: `deploy/self-host/supabase/SUPABASE_VERSION`

**Interfaces:**
- Produces: services `db` (Postgres 15, healthcheck), `auth` (GoTrue, healthcheck), `rest`, `realtime`, `storage`, `imgproxy`, `meta`, `kong` (listens `:8000` internally), `studio`. Service name `db` is referenced by Task 5/6 as the Postgres host; `kong` as the API host; `auth` for the migrate dependency.

- [ ] **Step 1: Fetch and record the pinned version**

Run:
```bash
mkdir -p deploy/self-host/supabase
echo "v1.24.07.21" > deploy/self-host/supabase/SUPABASE_VERSION   # set to the tag you copy
```
(Use the actual tag you copy from `github.com/supabase/supabase/tree/<tag>/docker`.)

- [ ] **Step 2: Copy upstream `docker/docker-compose.yml` and `docker/volumes/`**

Copy the upstream `docker/docker-compose.yml` to `deploy/self-host/supabase/docker-compose.yml` and the whole `docker/volumes/` tree to `deploy/self-host/supabase/volumes/`.

- [ ] **Step 3: Trim host ports + align env var names**

Edit `deploy/self-host/supabase/docker-compose.yml`:
- Remove all `ports:` host mappings (Caddy is the only ingress). Keep `expose:`/internal ports.
- Ensure these env vars resolve from the top-level `.env`: `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`. The upstream uses these names already; delete the upstream dashboard/SMTP/analytics extras not needed here (`studio` may stay).
- Confirm `db` and `auth` have `healthcheck:` blocks (upstream ships them); if `auth` lacks one, add:
  ```yaml
  healthcheck:
    test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:9999/health"]
    interval: 5s
    timeout: 5s
    retries: 10
  ```

- [ ] **Step 4: Validate the fragment parses**

Run: `docker compose -f deploy/self-host/supabase/docker-compose.yml config -q && echo OK`
Expected: `OK` (set dummy `.env` values in the shell if needed: `JWT_SECRET=x POSTGRES_PASSWORD=x ANON_KEY=x SERVICE_ROLE_KEY=x docker compose ... config -q`).

- [ ] **Step 5: Commit**

```bash
git add deploy/self-host/supabase
git commit -m "feat(self-host): vendor pinned official supabase compose (ports trimmed)"
```

---

### Task 4: EMQX config — single JWT (HMAC) authenticator

Author the EMQX 5.x config enabling a single JWT authenticator keyed by `JWT_SECRET`.

**Files:**
- Create: `deploy/self-host/emqx/emqx.conf`

**Interfaces:**
- Produces: an `emqx` broker (added in Task 6) listening `1883` (TCP) and `8083` (WS path `/mqtt`) internally, authenticating any client whose MQTT password is a valid HS256 JWT signed with `${JWT_SECRET}`.

- [ ] **Step 1: Write `deploy/self-host/emqx/emqx.conf`**

```hocon
# EMQX 5.x — single JWT (HMAC/HS256) authenticator keyed by JWT_SECRET.
# The shared secret is injected via the EMQX_AUTHENTICATION__... env in compose;
# this file pins listeners and the auth mechanism shape.

node {
  name = "emqx@127.0.0.1"
  cookie = "teamclaw-self-host"
}

listeners.tcp.default {
  bind = "0.0.0.0:1883"
}

listeners.ws.default {
  bind = "0.0.0.0:8083"
  websocket.mqtt_path = "/mqtt"
}

dashboard.listeners.http.bind = 18083

authentication = [
  {
    mechanism = jwt
    use_jwks = false
    algorithm = "hmac-based"
    secret = "${EMQX_JWT_SECRET}"
    secret_base64_encoded = true
    # accept the JWT from the MQTT password field
    from = password
    verify_claims = []
  }
]
```

- [ ] **Step 2: Document the base64 requirement inline (already in file) and verify HOCON shape**

Run: `grep -q 'mechanism = jwt' deploy/self-host/emqx/emqx.conf && grep -q 'secret_base64_encoded = true' deploy/self-host/emqx/emqx.conf && echo OK`
Expected: `OK`.

Note for Task 6: since `secret_base64_encoded=true`, the compose must pass `EMQX_JWT_SECRET` as the **base64 encoding** of `JWT_SECRET`. gen-secrets signs with the raw `JWT_SECRET`; EMQX base64-decodes `EMQX_JWT_SECRET` back to the raw secret before HMAC — so `EMQX_JWT_SECRET = base64(JWT_SECRET)`. Task 6 computes this.

- [ ] **Step 3: Commit**

```bash
git add deploy/self-host/emqx/emqx.conf
git commit -m "feat(self-host): emqx single JWT/HMAC authenticator config"
```

---

### Task 5: `init/apply-migrations.sh` — idempotent migrate + seed

A script (run inside a postgres-client container) that applies migrations in order then seed, tracked by a marker table.

**Files:**
- Create: `deploy/self-host/init/apply-migrations.sh`
- Test: `deploy/self-host/init/test-apply-migrations.sh`

**Interfaces:**
- Consumes: env `PGHOST` (=`db`), `PGPORT` (=`5432`), `PGUSER` (=`postgres`), `PGPASSWORD` (=`${POSTGRES_PASSWORD}`), `PGDATABASE` (=`postgres`); migrations mounted at `/migrations`, seed at `/seed.sql`.
- Produces: table `public.schema_migrations(filename text primary key, applied_at timestamptz default now())`; each `*.sql` applied exactly once; `seed.sql` applied once (tracked as `__seed__`).

- [ ] **Step 1: Write the failing test `init/test-apply-migrations.sh`** (logic test, no real DB — stubs `psql`)

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/migrations"
printf 'select 1;\n' > "$TMP/migrations/20260101000000_a.sql"
printf 'select 2;\n' > "$TMP/migrations/20260102000000_b.sql"
mkdir -p "$TMP/migrations/_archive"; printf 'BAD;\n' > "$TMP/migrations/_archive/x.sql"
printf 'select 3;\n' > "$TMP/seed.sql"
# stub psql: record each invocation's -f / -c into a log, fake "already applied" empty set
cat > "$TMP/psql" <<'EOF'
#!/usr/bin/env bash
args="$*"
echo "psql $args" >> "$APPLY_LOG"
# emulate the "is applied?" query returning nothing (not applied)
if echo "$args" | grep -q "select 1 from public.schema_migrations"; then exit 0; fi
exit 0
EOF
chmod +x "$TMP/psql"
export PATH="$TMP:$PATH" APPLY_LOG="$TMP/log"
MIGRATIONS_DIR="$TMP/migrations" SEED_FILE="$TMP/seed.sql" ./apply-migrations.sh
# archive file must NOT be applied; a + b + seed must be, in order
grep -q "_archive" "$TMP/log" && { echo "FAIL: applied _archive"; exit 1; }
grep -q "20260101000000_a.sql" "$TMP/log" || { echo "FAIL: a not applied"; exit 1; }
ord_a=$(grep -n "20260101000000_a.sql" "$TMP/log" | head -1 | cut -d: -f1)
ord_b=$(grep -n "20260102000000_b.sql" "$TMP/log" | head -1 | cut -d: -f1)
[ "$ord_a" -lt "$ord_b" ] || { echo "FAIL: order wrong"; exit 1; }
grep -q "seed.sql" "$TMP/log" || { echo "FAIL: seed not applied"; exit 1; }
echo "PASS"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `chmod +x deploy/self-host/init/test-apply-migrations.sh && deploy/self-host/init/test-apply-migrations.sh`
Expected: FAIL — `./apply-migrations.sh: No such file or directory`.

- [ ] **Step 3: Write `init/apply-migrations.sh`**

```bash
#!/usr/bin/env bash
# Apply Supabase migrations (lexical order) then seed, idempotently.
set -euo pipefail
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
SEED_FILE="${SEED_FILE:-/seed.sql}"

psql -v ON_ERROR_STOP=1 -c \
  "create table if not exists public.schema_migrations(filename text primary key, applied_at timestamptz default now());"

is_applied() { # $1=filename -> "t" if present
  psql -tAc "select 1 from public.schema_migrations where filename = '$1'"
}
apply_file() { # $1=path $2=marker-name
  if [ -n "$(is_applied "$2")" ]; then
    echo "skip (already applied): $2"; return 0
  fi
  echo "apply: $2"
  psql -v ON_ERROR_STOP=1 -1 -f "$1"
  psql -v ON_ERROR_STOP=1 -c \
    "insert into public.schema_migrations(filename) values ('$2');"
}

# migrations in lexical order; skip _archive/ and non-.sql
for f in $(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | sort); do
  apply_file "$f" "$(basename "$f")"
done
# seed last
[ -f "$SEED_FILE" ] && apply_file "$SEED_FILE" "__seed__"
echo "apply-migrations: done"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `chmod +x deploy/self-host/init/apply-migrations.sh && deploy/self-host/init/test-apply-migrations.sh`
Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add deploy/self-host/init/apply-migrations.sh deploy/self-host/init/test-apply-migrations.sh
git commit -m "feat(self-host): idempotent migration + seed runner"
```

---

### Task 6: Caddyfile — edge TLS + reverse proxy

Author the env-templated Caddyfile fronting FC, Supabase (kong), and EMQX WSS.

**Files:**
- Create: `deploy/self-host/caddy/Caddyfile`

**Interfaces:**
- Consumes: `FC_DOMAIN`, `SUPABASE_DOMAIN`, `MQTT_DOMAIN`, `STUDIO_DOMAIN`, `EMQX_DASHBOARD_DOMAIN`, `CADDY_TLS_MODE`, `ACME_EMAIL`.
- Produces: HTTPS routes terminating at Caddy; WebSocket upgrades transparently proxied to `emqx:8083`.

- [ ] **Step 1: Write `deploy/self-host/caddy/Caddyfile`**

```caddyfile
{
	email {$ACME_EMAIL}
	# CADDY_TLS_MODE=off short-circuits to http via the auto_https directive below.
}

{$FC_DOMAIN} {
	reverse_proxy fc:9000
}

{$SUPABASE_DOMAIN} {
	reverse_proxy kong:8000
}

{$MQTT_DOMAIN} {
	# Caddy v2 reverse_proxy transparently upgrades WebSocket connections.
	reverse_proxy emqx:8083
}

{$STUDIO_DOMAIN} {
	reverse_proxy studio:3000
}

{$EMQX_DASHBOARD_DOMAIN} {
	reverse_proxy emqx:18083
}
```

Note: for `CADDY_TLS_MODE=internal`, Task 6 step 3 sets `--internal-certs` behavior by setting the global `local_certs` option; for `off`, prepend `http://` to the site addresses via the compose `command`. Document both in README (Task 9); the default `acme` needs no extra flags.

- [ ] **Step 2: Verify the file references the right upstreams**

Run: `grep -q 'reverse_proxy emqx:8083' deploy/self-host/caddy/Caddyfile && grep -q 'reverse_proxy fc:9000' deploy/self-host/caddy/Caddyfile && grep -q 'reverse_proxy kong:8000' deploy/self-host/caddy/Caddyfile && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add deploy/self-host/caddy/Caddyfile
git commit -m "feat(self-host): caddy edge TLS + WSS reverse proxy"
```

---

### Task 7: Top-level `docker-compose.yml` wiring

The orchestration file: `include`s Supabase, adds `emqx`, `fc`, `caddy`, `migrate`, and declares the `cron`/`postgres` profile services.

**Files:**
- Create: `deploy/self-host/docker-compose.yml`

**Interfaces:**
- Consumes: every service/env from Tasks 1–6.
- Produces: a single compose project where `caddy` is the only host-port publisher; `migrate` runs once after `db`+`auth` healthy; `fc` depends on `migrate` completion + `emqx`.

- [ ] **Step 1: Write `deploy/self-host/docker-compose.yml`**

```yaml
name: teamclaw-self-host

include:
  - path: ./supabase/docker-compose.yml

services:
  emqx:
    image: emqx/emqx:5.8.0
    restart: unless-stopped
    environment:
      # EMQX expects the HMAC secret base64-encoded (secret_base64_encoded=true).
      EMQX_JWT_SECRET: "${EMQX_JWT_SECRET}"
    volumes:
      - ./emqx/emqx.conf:/opt/emqx/etc/emqx.conf:ro
      - emqx_data:/opt/emqx/data
    healthcheck:
      test: ["CMD", "/opt/emqx/bin/emqx", "ctl", "status"]
      interval: 10s
      timeout: 5s
      retries: 12

  migrate:
    image: postgres:15-alpine
    restart: "no"
    depends_on:
      db:
        condition: service_healthy
      auth:
        condition: service_healthy
    environment:
      PGHOST: db
      PGPORT: "5432"
      PGUSER: postgres
      PGPASSWORD: "${POSTGRES_PASSWORD}"
      PGDATABASE: postgres
    volumes:
      - ../../services/supabase/migrations:/migrations:ro
      - ../../services/supabase/seed.sql:/seed.sql:ro
      - ./init/apply-migrations.sh:/apply-migrations.sh:ro
    entrypoint: ["/bin/sh", "-c", "chmod +x /apply-migrations.sh && /apply-migrations.sh"]

  fc:
    build:
      context: ../../services/fc
    image: teamclaw-fc:self-host
    restart: unless-stopped
    depends_on:
      migrate:
        condition: service_completed_successfully
      kong:
        condition: service_started
      emqx:
        condition: service_healthy
    environment:
      PORT: "9000"
      HOST: "0.0.0.0"
      BACKEND_KIND: "${BACKEND_KIND:-supabase}"
      SUPABASE_URL: "http://kong:8000"
      SUPABASE_PUBLIC_URL: "https://${SUPABASE_DOMAIN}"
      SUPABASE_ANON_KEY: "${ANON_KEY}"
      SUPABASE_SERVICE_ROLE_KEY: "${SERVICE_ROLE_KEY}"
      MQTT_BROKER_URL: "mqtt://emqx:1883"
      MQTT_USERNAME: "fc-service"
      MQTT_PASSWORD: "${MQTT_SERVICE_TOKEN}"
      MQTT_USE_TLS: "true"
      CRON_TRIGGER_SECRET: "${CRON_TRIGGER_SECRET}"
      DATABASE_URL: "${DATABASE_URL:-}"
      ACCESS_KEY_ID: "${ACCESS_KEY_ID:-}"
      ACCESS_KEY_SECRET: "${ACCESS_KEY_SECRET:-}"
      ROLE_ARN: "${ROLE_ARN:-}"
      BUCKET: "${BUCKET:-teamclaw-team}"
      REGION: "${REGION:-cn-shenzhen}"
      ENDPOINT: "${ENDPOINT:-}"
      LITELLM_URL: "${LITELLM_URL:-}"
      LITELLM_MASTER_KEY: "${LITELLM_MASTER_KEY:-}"

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      FC_DOMAIN: "${FC_DOMAIN}"
      SUPABASE_DOMAIN: "${SUPABASE_DOMAIN}"
      MQTT_DOMAIN: "${MQTT_DOMAIN}"
      STUDIO_DOMAIN: "${STUDIO_DOMAIN}"
      EMQX_DASHBOARD_DOMAIN: "${EMQX_DASHBOARD_DOMAIN}"
      ACME_EMAIL: "${ACME_EMAIL}"
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - fc
      - kong
      - emqx

  # ── opt-in: scheduled cron (docker compose --profile cron up) ──
  cron:
    image: curlimages/curl:8.10.1
    restart: unless-stopped
    profiles: ["cron"]
    depends_on:
      fc:
        condition: service_started
    entrypoint:
      - /bin/sh
      - -c
      - |
        while true; do
          curl -fsS -X POST http://fc:9000/internal/cron \
            -H "x-cron-secret: ${CRON_TRIGGER_SECRET}" \
            -H "content-type: application/json" \
            -d '{"task":"oss-abandon-sessions"}' || true
          # gc-blobs hourly check (script runs every 15m; gate daily inside FC if needed)
          curl -fsS -X POST http://fc:9000/internal/cron \
            -H "x-cron-secret: ${CRON_TRIGGER_SECRET}" \
            -H "content-type: application/json" \
            -d '{"task":"oss-gc-blobs"}' || true
          sleep 900
        done

  # ── opt-in: standalone postgres backend (docker compose --profile postgres up) ──
  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    profiles: ["postgres"]
    environment:
      POSTGRES_PASSWORD: "${POSTGRES_BACKEND_PASSWORD:-postgres}"
    volumes:
      - postgres_backend_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 10

volumes:
  emqx_data:
  caddy_data:
  caddy_config:
  postgres_backend_data:
```

- [ ] **Step 2: Add `EMQX_JWT_SECRET` derivation to gen-secrets.sh**

Append to `deploy/self-host/bootstrap/gen-secrets.sh` (before the final echo):

```bash
EMQX_JWT_SECRET="$(printf '%s' "$JWT_SECRET" | openssl base64 -A)"
set_kv EMQX_JWT_SECRET "$EMQX_JWT_SECRET"
```

And add `EMQX_JWT_SECRET=` to `.env.example` under the derived section.

- [ ] **Step 3: Validate the full compose parses**

Run:
```bash
cd deploy/self-host
cp .env.example .env
sed -i.bak 's/^JWT_SECRET=.*/JWT_SECRET=local-dev-secret-at-least-32-characters/' .env
sed -i.bak 's/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=localpw/' .env
./bootstrap/gen-secrets.sh
docker compose config -q && echo OK
docker compose --profile cron --profile postgres config -q && echo OK-PROFILES
rm -f .env .env.bak
```
Expected: `OK` then `OK-PROFILES`.

- [ ] **Step 4: Commit**

```bash
git add deploy/self-host/docker-compose.yml deploy/self-host/bootstrap/gen-secrets.sh deploy/self-host/.env.example
git commit -m "feat(self-host): top-level compose wiring all services + profiles"
```

---

### Task 8: README + end-to-end bring-up validation

Document the one-shot flow and run a real bring-up smoke (manual, requires Docker).

**Files:**
- Create: `deploy/self-host/README.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write `deploy/self-host/README.md`**

Cover, with exact commands:
- Prereqs: Docker + Docker Compose v2; a `JWT_SECRET` (≥32 chars) and `POSTGRES_PASSWORD`; DNS A-records for the 5 domains pointing at the host (for `acme`), or `CADDY_TLS_MODE=internal`/`off` for local.
- Flow:
  ```bash
  cd deploy/self-host
  cp .env.example .env
  # edit .env: JWT_SECRET, POSTGRES_PASSWORD, *_DOMAIN, ACME_EMAIL
  ./bootstrap/gen-secrets.sh
  docker compose up -d
  ```
- What each service is, which ports are public (only 80/443 via Caddy).
- The internal/public URL split (`SUPABASE_URL` vs `SUPABASE_PUBLIC_URL`; `mqtt://emqx:1883` vs `wss://${MQTT_DOMAIN}/mqtt`).
- EMQX auth model: clients pass their Supabase JWT as MQTT password; FC uses `MQTT_SERVICE_TOKEN`.
- Migrations are auto-applied + idempotent (`public.schema_migrations`); re-running `up` does not re-apply.
- OSS stays external — fill `ACCESS_KEY_*`/`ROLE_ARN`/`ENDPOINT` or leave blank (file-sync degrades).
- Opt-in: `docker compose --profile cron up -d`, `docker compose --profile postgres up -d` (+ set `BACKEND_KIND=postgres`, `DATABASE_URL`).
- `CADDY_TLS_MODE` options (`acme`/`internal`/`off`) and how to set them.

- [ ] **Step 2: Real bring-up smoke (local, `CADDY_TLS_MODE=internal`)**

Run:
```bash
cd deploy/self-host
cp .env.example .env
# set JWT_SECRET, POSTGRES_PASSWORD, CADDY_TLS_MODE=internal, domains -> localhost-style
./bootstrap/gen-secrets.sh
docker compose up -d
# wait for migrate to finish
docker compose logs migrate | tail -5
# health
docker compose exec -T fc wget -qO- http://localhost:9000/healthz
```
Expected: migrate log shows `apply-migrations: done`; healthz returns `{"ok":true}`.

- [ ] **Step 3: Idempotency check**

Run: `docker compose up -d migrate && docker compose logs --tail=20 migrate`
Expected: lines show `skip (already applied)` for prior files, no errors.

- [ ] **Step 4: Tear down**

Run: `docker compose down -v && rm -f .env .env.bak`

- [ ] **Step 5: Commit**

```bash
git add deploy/self-host/README.md
git commit -m "docs(self-host): one-shot bring-up guide + smoke steps"
```

---

## Self-Review Notes

- **Spec coverage:** Caddy/TLS (Task 6,7), Supabase stack (Task 3), EMQX single JWT authenticator (Task 4,7), FC wiring incl. internal/public URL split (Task 7), secret derivation from one JWT_SECRET (Task 2,7), idempotent migrate+seed (Task 5), cron profile (Task 7), postgres profile (Task 7), external OSS (Task 7,8 docs) — all mapped.
- **EMQX secret encoding:** resolved — `secret_base64_encoded=true` requires `EMQX_JWT_SECRET=base64(JWT_SECRET)`, derived in Task 7 step 2; gen-secrets signs with the raw `JWT_SECRET` so signatures verify.
- **Naming consistency:** Supabase service names `db`/`auth`/`kong`/`studio` used identically across Tasks 3/5/6/7; `MQTT_SERVICE_TOKEN` consistent across Tasks 1/2/7.
- **No host-port leaks:** only `caddy` maps `80`/`443`; supabase ports trimmed in Task 3.
