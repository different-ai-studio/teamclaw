# Self-host All-in-one Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an additive all-in-one self-host deployment target that packages TeamClaw, Postgres-backed Cloud API, MinIO object storage, MQTT over WebSocket, and a single HTTP reverse proxy into one Docker image exposing one port.

**Architecture:** Add `deploy/self-host/all-in-one/` without changing the existing Compose stack. The image uses a Debian runtime, `supervisord` for long-running processes, an idempotent entrypoint for `/data` initialization and migrations, and Caddy as the only public listener on `8080`. All external traffic is path-routed through Caddy; internal services bind to localhost/private ports.

**Tech Stack:** Docker multi-stage builds, Debian Bookworm, Node 20, Rust release binary for `amuxd`, Postgres 15, Caddy 2, EMQX 5.10.3, MinIO and TeamClaw FC Postgres backend, POSIX shell scripts, `supervisord`, `curl`, `psql`.

---

## File Structure

Create these files:

- `deploy/self-host/all-in-one/README.md` — user-facing build/run instructions, data layout, platform assumptions, and known limits.
- `deploy/self-host/all-in-one/Dockerfile` — multi-stage build assembling `fc`, `amuxd`, config templates, scripts, and runtime packages.
- `deploy/self-host/all-in-one/entrypoint.sh` — one-shot initialization, secret generation, runtime config rendering, Postgres initialization, and supervisor handoff.
- `deploy/self-host/all-in-one/lib.sh` — shared shell helpers for logging, secure random generation, env-file writing, readiness checks, and JWT signing.
- `deploy/self-host/all-in-one/render-config.sh` — renders Caddy, EMQX, MinIO, `fc`, and daemon runtime config from persisted secrets.
- `deploy/self-host/all-in-one/supervisord.conf` — long-running service process definitions.
- `deploy/self-host/all-in-one/Caddyfile.template` — single-port path-based reverse proxy template.
- `deploy/self-host/all-in-one/emqx.conf.template` — EMQX config with WebSocket MQTT enabled and raw TCP disabled for public use.
- `deploy/self-host/all-in-one/healthcheck.sh` — container health check used by Dockerfile and smoke tests.
- `deploy/self-host/all-in-one/smoke.sh` — local smoke test script for image build/start/health/restart behavior.

Modify these files only if implementation proves necessary:

- `deploy/self-host/README.md` — add a short pointer to the new all-in-one README.
- `services/fc/lib/business-api.mjs` or nearby FC config only if `fc` cannot operate behind a path-based public URL with existing env vars.
- Client configuration docs only if the existing self-host instructions hard-code raw MQTT TCP for all targets.

Do not modify these existing paths for the first MVP:

- `deploy/self-host/docker-compose.yml`
- `deploy/self-host/supabase/docker-compose.yml`
- `deploy/self-host/bootstrap/*`

---

### Task 1: Document User-facing All-in-one Mode

**Files:**
- Create: `deploy/self-host/all-in-one/README.md`
- Modify: `deploy/self-host/README.md`

- [ ] **Step 1: Create the all-in-one README**

Write `deploy/self-host/all-in-one/README.md` with this content:

````markdown
# TeamClaw Self-host All-in-one

This deployment target is for platforms that allow exactly one Docker image and one exposed port.

It packages the self-host runtime into one container and exposes a single HTTP port, `8080` by default. Caddy is the only public listener. All other services run inside the same container and are reached through path-based routing.

## Status

This mode is additive. The existing Docker Compose deployment in `deploy/self-host/` remains the default multi-container deployment.

## Runtime Layout

Persistent state lives under `/data`:

```text
/data/teamclaw/secrets.env
/data/teamclaw/runtime.env
/data/postgres/
/data/storage/
/data/emqx/
/data/amuxd/
/data/caddy/
/data/logs/
```

## Public Endpoints

| Path | Purpose |
| --- | --- |
| `/healthz` | Container health check |
| `/v1/*` | TeamClaw Cloud API |
| `/auth/*` | Auth service |
| `/rest/*` | PostgREST |
| `/storage/*` | Storage API |
| `/realtime/*` | Realtime WebSocket |
| `/mqtt` | MQTT over WebSocket |
| `/` | Deployment landing response |

Raw MQTT TCP `1883` is not exposed in this mode. Clients must use `ws://host:8080/mqtt` or `wss://host/mqtt`.

## Build

Run from the repository root:

```bash
docker build -f deploy/self-host/all-in-one/Dockerfile -t teamclaw-selfhost-allinone .
```

## Run Locally

```bash
docker volume create teamclaw-data
docker run --rm --name teamclaw-allinone -p 8080:8080 -v teamclaw-data:/data teamclaw-selfhost-allinone
```

Open:

```text
http://127.0.0.1:8080/healthz
```

## Client URLs

Use one public base URL:

```dotenv
PUBLIC_BASE_URL=http://127.0.0.1:8080
VITE_CLOUD_API_URL=http://127.0.0.1:8080/v1
VITE_MQTT_WS_URL=ws://127.0.0.1:8080/mqtt
```

For HTTPS platforms:

```dotenv
PUBLIC_BASE_URL=https://your-host.example.com
VITE_CLOUD_API_URL=https://your-host.example.com/v1
VITE_MQTT_WS_URL=wss://your-host.example.com/mqtt
```

## First Boot

On first boot, the entrypoint creates `/data/teamclaw/secrets.env` and generates required secrets. Later boots reuse the same file so tokens and stored data remain stable.

## Limits

This mode is intended for constrained self-host platforms, demos, and small installations. It is not a multi-node high-availability deployment. The container includes its own database and broker, so the platform must provide a persistent volume for `/data`.
````

- [ ] **Step 2: Add a pointer from the existing README**

Append this section near the deployment options in `deploy/self-host/README.md`:

```markdown
## Single-image platform mode

If your platform allows only one Docker image and one exposed port, use the experimental all-in-one target in `deploy/self-host/all-in-one/`. It keeps the Compose deployment unchanged and routes Cloud API, auth, storage, and MQTT-over-WebSocket through one HTTP entrypoint.
```

- [ ] **Step 3: Verify markdown content**

Run:

```bash
rg -n "all-in-one|Single-image|/mqtt|1883" deploy/self-host/README.md deploy/self-host/all-in-one/README.md
```

Expected: matches in both README files, with `/mqtt` and `1883` documented only for all-in-one mode.

- [ ] **Step 4: Commit**

```bash
git add deploy/self-host/README.md deploy/self-host/all-in-one/README.md
git commit -m "docs: add all-in-one self-host mode"
```

---

### Task 2: Add Shell Helper Library and Syntax Tests

**Files:**
- Create: `deploy/self-host/all-in-one/lib.sh`

- [ ] **Step 1: Create shared helper functions**

Write `deploy/self-host/all-in-one/lib.sh`:

```sh
#!/usr/bin/env sh
set -eu

log() {
  printf '[teamclaw-allinone] %s\n' "$*" >&2
}

fatal() {
  printf '[teamclaw-allinone] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "missing required command: $1"
}

rand_hex() {
  bytes="${1:-32}"
  openssl rand -hex "$bytes"
}

rand_base64_url() {
  bytes="${1:-32}"
  openssl rand -base64 "$bytes" | tr '+/' '-_' | tr -d '=\n'
}

ensure_dir() {
  mkdir -p "$1"
}

write_env_value() {
  file="$1"
  key="$2"
  value="$3"
  ensure_dir "$(dirname "$file")"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$file" > "${file}.tmp"
    mv "${file}.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

read_env_value() {
  file="$1"
  key="$2"
  grep "^${key}=" "$file" | tail -n 1 | cut -d= -f2-
}

ensure_env_value() {
  file="$1"
  key="$2"
  generator="$3"
  if [ -f "$file" ] && grep -q "^${key}=" "$file"; then
    read_env_value "$file" "$key"
    return 0
  fi
  value="$($generator)"
  write_env_value "$file" "$key" "$value"
  printf '%s\n' "$value"
}

wait_for_tcp() {
  host="$1"
  port="$2"
  label="$3"
  attempts="${4:-60}"
  i=1
  while [ "$i" -le "$attempts" ]; do
    if nc -z "$host" "$port" >/dev/null 2>&1; then
      log "$label is ready at $host:$port"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  fatal "$label did not become ready at $host:$port"
}

wait_for_http() {
  url="$1"
  label="$2"
  attempts="${3:-60}"
  i=1
  while [ "$i" -le "$attempts" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$label is ready at $url"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  fatal "$label did not become ready at $url"
}

jwt_base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

jwt_sign_hs256() {
  secret="$1"
  header="$2"
  payload="$3"
  header_b64="$(printf '%s' "$header" | jwt_base64url)"
  payload_b64="$(printf '%s' "$payload" | jwt_base64url)"
  signing_input="${header_b64}.${payload_b64}"
  signature="$(printf '%s' "$signing_input" | openssl dgst -sha256 -hmac "$secret" -binary | jwt_base64url)"
  printf '%s.%s\n' "$signing_input" "$signature"
}
```

- [ ] **Step 2: Make the helper executable**

Run:

```bash
chmod +x deploy/self-host/all-in-one/lib.sh
```

- [ ] **Step 3: Verify shell syntax**

Run:

```bash
sh -n deploy/self-host/all-in-one/lib.sh
```

Expected: no output and exit code `0`.

- [ ] **Step 4: Verify JWT helper produces three segments**

Run:

```bash
. deploy/self-host/all-in-one/lib.sh
jwt_sign_hs256 "secret" '{"alg":"HS256","typ":"JWT"}' '{"role":"anon"}' | awk -F. '{print NF}'
```

Expected output:

```text
3
```

- [ ] **Step 5: Commit**

```bash
git add deploy/self-host/all-in-one/lib.sh
git commit -m "feat: add all-in-one shell helpers"
```

---

### Task 3: Add Runtime Config Templates

**Files:**
- Create: `deploy/self-host/all-in-one/Caddyfile.template`
- Create: `deploy/self-host/all-in-one/emqx.conf.template`

- [ ] **Step 1: Create Caddy path-routing template**

Write `deploy/self-host/all-in-one/Caddyfile.template`:

```caddyfile
{
  auto_https off
}

:8080 {
  encode zstd gzip

  @health path /healthz
  handle @health {
    reverse_proxy 127.0.0.1:19090
  }

  @mqtt path /mqtt
  handle @mqtt {
    reverse_proxy 127.0.0.1:8083
  }

  handle_path /v1/* {
    reverse_proxy 127.0.0.1:9000
  }

  handle_path /api/* {
    reverse_proxy 127.0.0.1:9000
  }

  handle_path /auth/* {
    reverse_proxy 127.0.0.1:9999
  }

  handle_path /rest/* {
    reverse_proxy 127.0.0.1:3000
  }

  handle_path /storage/* {
    reverse_proxy 127.0.0.1:5000
  }

  handle_path /realtime/* {
    reverse_proxy 127.0.0.1:4000
  }

  handle / {
    respond "TeamClaw self-host all-in-one is running" 200
  }

  handle {
    respond "not found" 404
  }
}
```

- [ ] **Step 2: Create EMQX WebSocket-only public template**

Write `deploy/self-host/all-in-one/emqx.conf.template`:

```hocon
node.name = teamclaw@127.0.0.1

listeners.tcp.default {
  bind = "127.0.0.1:1883"
  max_connections = 1024
}

listeners.ws.default {
  bind = "127.0.0.1:8083"
  websocket.mqtt_path = "/mqtt"
  max_connections = 1024
}

allow_anonymous = false

jwt {
  secret = "${EMQX_JWT_SECRET}"
  secret_base64_encoded = true
  from = password
}

authentication = [
  {
    mechanism = jwt
    backend = built_in_database
    use_jwks = false
    algorithm = hmac-based
    secret = "${EMQX_JWT_SECRET}"
    secret_base64_encoded = true
    from = password
  }
]

dashboard.listeners.http.bind = "127.0.0.1:18083"
```

- [ ] **Step 3: Verify templates are present**

Run:

```bash
rg -n "127.0.0.1:8083|handle_path /v1|allow_anonymous = false" deploy/self-host/all-in-one
```

Expected: matches in the Caddy and EMQX templates.

- [ ] **Step 4: Commit**

```bash
git add deploy/self-host/all-in-one/Caddyfile.template deploy/self-host/all-in-one/emqx.conf.template
git commit -m "feat: add all-in-one routing templates"
```

---

### Task 4: Add Config Rendering Script

**Files:**
- Create: `deploy/self-host/all-in-one/render-config.sh`

- [ ] **Step 1: Create renderer**

Write `deploy/self-host/all-in-one/render-config.sh`:

```sh
#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

DATA_DIR="${DATA_DIR:-/data}"
RUN_DIR="${RUN_DIR:-/run/teamclaw}"
SECRETS_FILE="${SECRETS_FILE:-$DATA_DIR/teamclaw/secrets.env}"
RUNTIME_ENV="$DATA_DIR/teamclaw/runtime.env"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1:8080}"

[ -f "$SECRETS_FILE" ] || fatal "missing secrets file: $SECRETS_FILE"

ensure_dir "$RUN_DIR"
ensure_dir "$RUN_DIR/caddy"
ensure_dir "$RUN_DIR/emqx"
ensure_dir "$RUN_DIR/fc"
ensure_dir "$RUN_DIR/amuxd"

set -a
. "$SECRETS_FILE"
set +a

export EMQX_JWT_SECRET

envsubst < "$SCRIPT_DIR/Caddyfile.template" > "$RUN_DIR/caddy/Caddyfile"
envsubst < "$SCRIPT_DIR/emqx.conf.template" > "$RUN_DIR/emqx/emqx.conf"

cat > "$RUNTIME_ENV" <<EOF_RUNTIME
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
CLOUD_API_URL=$PUBLIC_BASE_URL/v1
SUPABASE_PUBLIC_URL=$PUBLIC_BASE_URL
MQTT_WS_URL=${PUBLIC_BASE_URL/http:/ws:}/mqtt
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=postgres
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
SUPABASE_URL=http://127.0.0.1:8000
SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
MQTT_BROKER_URL=mqtt://127.0.0.1:1883
MQTT_PUBLIC_BROKER_URL=${PUBLIC_BASE_URL/http:/ws:}/mqtt
MQTT_USERNAME=fc-service
MQTT_PASSWORD=$MQTT_SERVICE_TOKEN
MQTT_USE_TLS=false
CRON_TRIGGER_SECRET=$CRON_TRIGGER_SECRET
EOF_RUNTIME

cat > "$RUN_DIR/fc/env" <<EOF_FC
PORT=9000
HOST=127.0.0.1
BACKEND_KIND=supabase
SUPABASE_URL=http://127.0.0.1:8000
SUPABASE_PUBLIC_URL=$PUBLIC_BASE_URL
SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
MQTT_BROKER_URL=mqtt://127.0.0.1:1883
MQTT_PUBLIC_BROKER_URL=${PUBLIC_BASE_URL/http:/ws:}/mqtt
MQTT_USERNAME=fc-service
MQTT_PASSWORD=$MQTT_SERVICE_TOKEN
MQTT_USE_TLS=false
CRON_TRIGGER_SECRET=$CRON_TRIGGER_SECRET
BUCKET=teamclaw-team
REGION=local
ENDPOINT=http://127.0.0.1:5000/storage/v1/s3
EOF_FC

cat > "$RUN_DIR/amuxd/backend.toml" <<EOF_AMUXD
backend_kind = "cloud_api"
cloud_api_url = "$PUBLIC_BASE_URL/v1"
mqtt_broker_url = "${PUBLIC_BASE_URL/http:/ws:}/mqtt"
EOF_AMUXD

log "rendered runtime config into $RUN_DIR"
```

- [ ] **Step 2: Make renderer executable**

Run:

```bash
chmod +x deploy/self-host/all-in-one/render-config.sh
```

- [ ] **Step 3: Verify shell syntax**

Run:

```bash
sh -n deploy/self-host/all-in-one/render-config.sh
```

Expected: no output and exit code `0`.

- [ ] **Step 4: Verify renderer fails clearly without secrets**

Run:

```bash
DATA_DIR="$(mktemp -d)" deploy/self-host/all-in-one/render-config.sh
```

Expected: non-zero exit and message containing `missing secrets file`.

- [ ] **Step 5: Commit**

```bash
git add deploy/self-host/all-in-one/render-config.sh
git commit -m "feat: render all-in-one runtime config"
```

---

### Task 5: Add Entrypoint Initialization

**Files:**
- Create: `deploy/self-host/all-in-one/entrypoint.sh`

- [ ] **Step 1: Create entrypoint**

Write `deploy/self-host/all-in-one/entrypoint.sh`:

```sh
#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

DATA_DIR="${DATA_DIR:-/data}"
RUN_DIR="${RUN_DIR:-/run/teamclaw}"
SECRETS_FILE="$DATA_DIR/teamclaw/secrets.env"
PGDATA="$DATA_DIR/postgres"

require_cmd openssl
require_cmd envsubst
require_cmd supervisord
require_cmd initdb
require_cmd pg_ctl
require_cmd psql
require_cmd curl
require_cmd nc

ensure_dir "$DATA_DIR/teamclaw"
ensure_dir "$DATA_DIR/storage"
ensure_dir "$DATA_DIR/emqx"
ensure_dir "$DATA_DIR/amuxd"
ensure_dir "$DATA_DIR/caddy"
ensure_dir "$DATA_DIR/logs"
ensure_dir "$RUN_DIR"

make_hex_32() { rand_hex 32; }
make_b64_32() { rand_base64_url 32; }
make_jwt_secret() { rand_base64_url 48; }

POSTGRES_PASSWORD="$(ensure_env_value "$SECRETS_FILE" POSTGRES_PASSWORD make_b64_32)"
JWT_SECRET="$(ensure_env_value "$SECRETS_FILE" JWT_SECRET make_jwt_secret)"
ensure_env_value "$SECRETS_FILE" CRON_TRIGGER_SECRET make_b64_32 >/dev/null
ensure_env_value "$SECRETS_FILE" MQTT_SERVICE_TOKEN make_b64_32 >/dev/null
ensure_env_value "$SECRETS_FILE" STORAGE_ENCRYPTION_KEY make_hex_32 >/dev/null

ANON_KEY="$(jwt_sign_hs256 "$JWT_SECRET" '{"alg":"HS256","typ":"JWT"}' '{"role":"anon","iss":"supabase","iat":1700000000,"exp":4102444800}')"
SERVICE_ROLE_KEY="$(jwt_sign_hs256 "$JWT_SECRET" '{"alg":"HS256","typ":"JWT"}' '{"role":"service_role","iss":"supabase","iat":1700000000,"exp":4102444800}')"
EMQX_JWT_SECRET="$(printf '%s' "$JWT_SECRET" | openssl base64 -A)"

write_env_value "$SECRETS_FILE" ANON_KEY "$ANON_KEY"
write_env_value "$SECRETS_FILE" SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY"
write_env_value "$SECRETS_FILE" EMQX_JWT_SECRET "$EMQX_JWT_SECRET"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "initializing postgres data directory"
  install -d -m 0700 "$PGDATA"
  initdb -D "$PGDATA" --username=postgres --pwfile=<(printf '%s\n' "$POSTGRES_PASSWORD")
fi

"$SCRIPT_DIR/render-config.sh"

log "starting postgres for migration phase"
pg_ctl -D "$PGDATA" -o "-c listen_addresses=127.0.0.1 -p 5432" -w start

export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER=postgres
export PGPASSWORD="$POSTGRES_PASSWORD"
export PGDATABASE=postgres

psql -v ON_ERROR_STOP=1 -c "select 1" >/dev/null

if [ -x /opt/teamclaw/apply-migrations.sh ]; then
  MIGRATIONS_DIR=/opt/teamclaw/migrations SEED_FILE=/opt/teamclaw/seed.sql APPLY_SEED=false /opt/teamclaw/apply-migrations.sh
fi

pg_ctl -D "$PGDATA" -m fast -w stop

log "starting supervisor"
exec supervisord -c /etc/supervisor/conf.d/teamclaw-all-in-one.conf
```

- [ ] **Step 2: Replace process substitution for POSIX shell compatibility**

The previous step uses process substitution, which is not POSIX `sh`. Replace this line:

```sh
  initdb -D "$PGDATA" --username=postgres --pwfile=<(printf '%s\n' "$POSTGRES_PASSWORD")
```

with:

```sh
  pwfile="$RUN_DIR/postgres-pwfile"
  printf '%s\n' "$POSTGRES_PASSWORD" > "$pwfile"
  chmod 0600 "$pwfile"
  initdb -D "$PGDATA" --username=postgres --pwfile="$pwfile"
  rm -f "$pwfile"
```

- [ ] **Step 3: Make entrypoint executable**

Run:

```bash
chmod +x deploy/self-host/all-in-one/entrypoint.sh
```

- [ ] **Step 4: Verify shell syntax**

Run:

```bash
sh -n deploy/self-host/all-in-one/entrypoint.sh
```

Expected: no output and exit code `0`.

- [ ] **Step 5: Commit**

```bash
git add deploy/self-host/all-in-one/entrypoint.sh
git commit -m "feat: initialize all-in-one runtime"
```

---

### Task 6: Add Supervisor and Healthcheck

**Files:**
- Create: `deploy/self-host/all-in-one/supervisord.conf`
- Create: `deploy/self-host/all-in-one/healthcheck.sh`

- [ ] **Step 1: Create supervisor config**

Write `deploy/self-host/all-in-one/supervisord.conf`:

```ini
[supervisord]
nodaemon=true
logfile=/data/logs/supervisord.log
pidfile=/run/teamclaw/supervisord.pid
childlogdir=/data/logs

[program:postgres]
command=/usr/lib/postgresql/15/bin/postgres -D /data/postgres -c listen_addresses=127.0.0.1 -p 5432
autostart=true
autorestart=true
priority=10
stdout_logfile=/data/logs/postgres.log
stderr_logfile=/data/logs/postgres.err.log

[program:emqx]
command=/opt/emqx/bin/emqx foreground -c /run/teamclaw/emqx/emqx.conf
autostart=true
autorestart=true
priority=20
environment=HOME="/data/emqx"
stdout_logfile=/data/logs/emqx.log
stderr_logfile=/data/logs/emqx.err.log

[program:fc]
command=/bin/sh -c '. /run/teamclaw/fc/env && cd /opt/teamclaw/fc && exec node dist/server.js'
autostart=true
autorestart=true
priority=40
environment=NODE_ENV="production"
stdout_logfile=/data/logs/fc.log
stderr_logfile=/data/logs/fc.err.log

[program:amuxd]
command=/bin/sh -c 'HOME=/data/amuxd exec /usr/local/bin/amuxd start'
autostart=true
autorestart=true
priority=50
stdout_logfile=/data/logs/amuxd.log
stderr_logfile=/data/logs/amuxd.err.log

[program:health]
command=/opt/teamclaw/healthcheck.sh --serve
autostart=true
autorestart=true
priority=80
stdout_logfile=/data/logs/health.log
stderr_logfile=/data/logs/health.err.log

[program:caddy]
command=/usr/bin/caddy run --config /run/teamclaw/caddy/Caddyfile --adapter caddyfile
autostart=true
autorestart=true
priority=90
environment=XDG_DATA_HOME="/data/caddy/data",XDG_CONFIG_HOME="/data/caddy/config"
stdout_logfile=/data/logs/caddy.log
stderr_logfile=/data/logs/caddy.err.log
```

- [ ] **Step 2: Create healthcheck script**

Write `deploy/self-host/all-in-one/healthcheck.sh`:

```sh
#!/usr/bin/env sh
set -eu

check_once() {
  curl -fsS http://127.0.0.1:9000/healthz >/dev/null
  pg_isready -h 127.0.0.1 -p 5432 -U postgres >/dev/null
  nc -z 127.0.0.1 8083 >/dev/null
}

serve() {
  while true; do
    {
      printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok'
    } | nc -l -p 19090 -q 1 >/dev/null 2>&1 || true
  done
}

case "${1:-}" in
  --serve)
    serve
    ;;
  *)
    check_once
    ;;
esac
```

- [ ] **Step 3: Make healthcheck executable**

Run:

```bash
chmod +x deploy/self-host/all-in-one/healthcheck.sh
```

- [ ] **Step 4: Verify syntax**

Run:

```bash
sh -n deploy/self-host/all-in-one/healthcheck.sh
python3 - <<'PY'
from pathlib import Path
text = Path('deploy/self-host/all-in-one/supervisord.conf').read_text()
for name in ['postgres', 'emqx', 'fc', 'amuxd', 'health', 'caddy']:
    assert f'[program:{name}]' in text, name
print('ok')
PY
```

Expected output contains:

```text
ok
```

- [ ] **Step 5: Commit**

```bash
git add deploy/self-host/all-in-one/supervisord.conf deploy/self-host/all-in-one/healthcheck.sh
git commit -m "feat: supervise all-in-one services"
```

---

### Task 7: Add All-in-one Dockerfile

**Files:**
- Create: `deploy/self-host/all-in-one/Dockerfile`

- [ ] **Step 1: Create Dockerfile**

Write `deploy/self-host/all-in-one/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

FROM node:20-slim AS fc-build
WORKDIR /src
COPY services/fc/package.json services/fc/package-lock.json services/fc/.npmrc ./
RUN npm ci
COPY services/fc ./
RUN npm run build
RUN npm ci --omit=dev && npm cache clean --force

FROM rust:1-bookworm AS amuxd-build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev cmake clang protobuf-compiler \
  && rm -rf /var/lib/apt/lists/*
COPY . .
ENV CARGO_TARGET_DIR=/out
RUN cargo build --release -p amuxd --bin amuxd

FROM emqx/emqx:5.10.3 AS emqx-image

FROM debian:bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive
ENV DATA_DIR=/data
ENV RUN_DIR=/run/teamclaw

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssl gettext-base netcat-openbsd supervisor \
    postgresql-15 postgresql-client-15 caddy nodejs npm \
  && rm -rf /var/lib/apt/lists/*

COPY --from=emqx-image /opt/emqx /opt/emqx
COPY --from=fc-build /src/package.json /opt/teamclaw/fc/package.json
COPY --from=fc-build /src/node_modules /opt/teamclaw/fc/node_modules
COPY --from=fc-build /src/dist /opt/teamclaw/fc/dist
COPY --from=amuxd-build /out/release/amuxd /usr/local/bin/amuxd

COPY services/supabase/migrations /opt/teamclaw/migrations
COPY services/supabase/seed.sql /opt/teamclaw/seed.sql
COPY deploy/self-host/init/apply-migrations.sh /opt/teamclaw/apply-migrations.sh
COPY deploy/self-host/all-in-one/lib.sh /opt/teamclaw/lib.sh
COPY deploy/self-host/all-in-one/render-config.sh /opt/teamclaw/render-config.sh
COPY deploy/self-host/all-in-one/entrypoint.sh /opt/teamclaw/entrypoint.sh
COPY deploy/self-host/all-in-one/healthcheck.sh /opt/teamclaw/healthcheck.sh
COPY deploy/self-host/all-in-one/Caddyfile.template /opt/teamclaw/Caddyfile.template
COPY deploy/self-host/all-in-one/emqx.conf.template /opt/teamclaw/emqx.conf.template
COPY deploy/self-host/all-in-one/supervisord.conf /etc/supervisor/conf.d/teamclaw-all-in-one.conf

RUN chmod +x \
    /opt/teamclaw/apply-migrations.sh \
    /opt/teamclaw/lib.sh \
    /opt/teamclaw/render-config.sh \
    /opt/teamclaw/entrypoint.sh \
    /opt/teamclaw/healthcheck.sh \
  && ln -sf /opt/teamclaw/lib.sh /opt/teamclaw/all-in-one-lib.sh

WORKDIR /opt/teamclaw
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD /opt/teamclaw/healthcheck.sh
ENTRYPOINT ["/opt/teamclaw/entrypoint.sh"]
```

- [ ] **Step 2: Align script paths with Dockerfile location**

Because scripts use `SCRIPT_DIR`, they must find templates next to themselves at runtime. Confirm these files are copied to the same directory in the Dockerfile:

```text
/opt/teamclaw/lib.sh
/opt/teamclaw/render-config.sh
/opt/teamclaw/entrypoint.sh
/opt/teamclaw/Caddyfile.template
/opt/teamclaw/emqx.conf.template
```

If any path differs, update the Dockerfile copy destination so all five files live under `/opt/teamclaw/`.

- [ ] **Step 3: Verify Dockerfile references existing sources**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
text = Path('deploy/self-host/all-in-one/Dockerfile').read_text()
required = [
    'services/fc/package.json',
    'services/supabase/migrations',
    'deploy/self-host/init/apply-migrations.sh',
    'deploy/self-host/all-in-one/entrypoint.sh',
]
for item in required:
    assert item in text, item
print('ok')
PY
```

Expected output:

```text
ok
```

- [ ] **Step 4: Commit**

```bash
git add deploy/self-host/all-in-one/Dockerfile
git commit -m "feat: add all-in-one Docker image"
```

---

### Task 8: Make Runtime Scripts Work Both In-repo and In-image

**Files:**
- Modify: `deploy/self-host/all-in-one/render-config.sh`
- Modify: `deploy/self-host/all-in-one/entrypoint.sh`

- [ ] **Step 1: Add template lookup helper to renderer**

In `deploy/self-host/all-in-one/render-config.sh`, insert this function after variable initialization:

```sh
find_asset() {
  name="$1"
  if [ -f "$SCRIPT_DIR/$name" ]; then
    printf '%s\n' "$SCRIPT_DIR/$name"
    return 0
  fi
  if [ -f "/opt/teamclaw/$name" ]; then
    printf '%s\n' "/opt/teamclaw/$name"
    return 0
  fi
  fatal "missing asset: $name"
}
```

Then replace template rendering lines with:

```sh
envsubst < "$(find_asset Caddyfile.template)" > "$RUN_DIR/caddy/Caddyfile"
envsubst < "$(find_asset emqx.conf.template)" > "$RUN_DIR/emqx/emqx.conf"
```

- [ ] **Step 2: Add script lookup helper to entrypoint**

In `deploy/self-host/all-in-one/entrypoint.sh`, insert this function after variable initialization:

```sh
find_script() {
  name="$1"
  if [ -x "$SCRIPT_DIR/$name" ]; then
    printf '%s\n' "$SCRIPT_DIR/$name"
    return 0
  fi
  if [ -x "/opt/teamclaw/$name" ]; then
    printf '%s\n' "/opt/teamclaw/$name"
    return 0
  fi
  fatal "missing executable script: $name"
}
```

Then replace:

```sh
"$SCRIPT_DIR/render-config.sh"
```

with:

```sh
"$(find_script render-config.sh)"
```

- [ ] **Step 3: Verify scripts still parse**

Run:

```bash
sh -n deploy/self-host/all-in-one/render-config.sh
sh -n deploy/self-host/all-in-one/entrypoint.sh
```

Expected: no output and exit code `0`.

- [ ] **Step 4: Commit**

```bash
git add deploy/self-host/all-in-one/render-config.sh deploy/self-host/all-in-one/entrypoint.sh
git commit -m "fix: support all-in-one script asset lookup"
```

---

### Task 9: Add Smoke Test Script

**Files:**
- Create: `deploy/self-host/all-in-one/smoke.sh`

- [ ] **Step 1: Create smoke script**

Write `deploy/self-host/all-in-one/smoke.sh`:

```sh
#!/usr/bin/env sh
set -eu

IMAGE="${IMAGE:-teamclaw-selfhost-allinone:local}"
CONTAINER="${CONTAINER:-teamclaw-allinone-smoke}"
VOLUME="${VOLUME:-teamclaw-allinone-smoke-data}"
PORT="${PORT:-18080}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

wait_http() {
  url="$1"
  i=1
  while [ "$i" -le 120 ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    i=$((i + 1))
  done
  docker logs "$CONTAINER" >&2 || true
  return 1
}

cleanup

docker build -f deploy/self-host/all-in-one/Dockerfile -t "$IMAGE" .
docker volume create "$VOLUME" >/dev/null

docker run -d --name "$CONTAINER" -p "$PORT:8080" -v "$VOLUME:/data" "$IMAGE" >/dev/null
wait_http "http://127.0.0.1:$PORT/healthz"
curl -fsS "http://127.0.0.1:$PORT/" | grep -q "TeamClaw self-host all-in-one"

docker restart "$CONTAINER" >/dev/null
wait_http "http://127.0.0.1:$PORT/healthz"

docker exec "$CONTAINER" test -s /data/teamclaw/secrets.env

echo "all-in-one smoke passed"
cleanup
```

- [ ] **Step 2: Make smoke script executable**

Run:

```bash
chmod +x deploy/self-host/all-in-one/smoke.sh
```

- [ ] **Step 3: Verify syntax**

Run:

```bash
sh -n deploy/self-host/all-in-one/smoke.sh
```

Expected: no output and exit code `0`.

- [ ] **Step 4: Commit**

```bash
git add deploy/self-host/all-in-one/smoke.sh
git commit -m "test: add all-in-one smoke script"
```

---

### Task 10: Build Image and Fix Packaging Breakages

**Files:**
- Modify: `deploy/self-host/all-in-one/Dockerfile`
- Modify: `deploy/self-host/all-in-one/entrypoint.sh`
- Modify: `deploy/self-host/all-in-one/render-config.sh`
- Modify: `deploy/self-host/all-in-one/healthcheck.sh`
- Modify: `deploy/self-host/all-in-one/Caddyfile.template`
- Modify: `deploy/self-host/all-in-one/emqx.conf.template`

- [ ] **Step 1: Build the image**

Run:

```bash
docker build -f deploy/self-host/all-in-one/Dockerfile -t teamclaw-selfhost-allinone:local .
```

Expected: build succeeds.

- [ ] **Step 2: If Node package copy fails, inspect FC package files**

Run:

```bash
ls -la services/fc/package.json services/fc/package-lock.json services/fc/.npmrc
```

If `services/fc/package-lock.json` or `services/fc/.npmrc` is missing, update the Dockerfile FC build stage to copy only existing files and run the install command used by `services/fc/Dockerfile`.

- [ ] **Step 3: If Postgres binaries are not on PATH, use absolute paths**

Run inside a temporary container:

```bash
docker run --rm --entrypoint sh teamclaw-selfhost-allinone:local -c 'command -v initdb || ls /usr/lib/postgresql/15/bin/initdb'
```

If `command -v initdb` fails, update `entrypoint.sh` command checks and invocations to use:

```sh
POSTGRES_BIN="${POSTGRES_BIN:-/usr/lib/postgresql/15/bin}"
require_cmd "$POSTGRES_BIN/initdb"
require_cmd "$POSTGRES_BIN/pg_ctl"
"$POSTGRES_BIN/initdb" -D "$PGDATA" --username=postgres --pwfile="$pwfile"
"$POSTGRES_BIN/pg_ctl" -D "$PGDATA" -o "-c listen_addresses=127.0.0.1 -p 5432" -w start
"$POSTGRES_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop
```

- [ ] **Step 4: Commit packaging fixes**

```bash
git add deploy/self-host/all-in-one
git commit -m "fix: make all-in-one image build"
```

---

### Task 11: Run Container Smoke and Fix Startup Breakages

**Files:**
- Modify: `deploy/self-host/all-in-one/entrypoint.sh`
- Modify: `deploy/self-host/all-in-one/supervisord.conf`
- Modify: `deploy/self-host/all-in-one/healthcheck.sh`
- Modify: `deploy/self-host/all-in-one/Caddyfile.template`
- Modify: `deploy/self-host/all-in-one/emqx.conf.template`

- [ ] **Step 1: Run smoke script**

Run:

```bash
IMAGE=teamclaw-selfhost-allinone:local PORT=18080 deploy/self-host/all-in-one/smoke.sh
```

Expected output:

```text
all-in-one smoke passed
```

- [ ] **Step 2: If health fails, inspect logs**

Run:

```bash
docker logs teamclaw-allinone-smoke
docker exec teamclaw-allinone-smoke sh -c 'ls -la /data/logs && tail -n 200 /data/logs/*.err.log /data/logs/*.log 2>/dev/null'
```

Use the failing service log to make the smallest config or startup fix.

- [ ] **Step 3: Verify one exposed port**

Run:

```bash
docker inspect teamclaw-selfhost-allinone:local --format '{{json .Config.ExposedPorts}}'
```

Expected output contains only:

```json
{"8080/tcp":{}}
```

- [ ] **Step 4: Verify persisted secrets survive restart**

Run:

```bash
docker exec teamclaw-allinone-smoke sh -c 'sha256sum /data/teamclaw/secrets.env' > /tmp/teamclaw-secrets-before.txt
docker restart teamclaw-allinone-smoke >/dev/null
sleep 10
docker exec teamclaw-allinone-smoke sh -c 'sha256sum /data/teamclaw/secrets.env' > /tmp/teamclaw-secrets-after.txt
diff -u /tmp/teamclaw-secrets-before.txt /tmp/teamclaw-secrets-after.txt
```

Expected: `diff` has no output.

- [ ] **Step 5: Commit startup fixes**

```bash
git add deploy/self-host/all-in-one
git commit -m "fix: make all-in-one container start"
```

---

### Task 12: Verify Existing Compose Path Is Unchanged

**Files:**
- No source changes expected

- [ ] **Step 1: Confirm Compose files are not modified**

Run:

```bash
git diff -- deploy/self-host/docker-compose.yml deploy/self-host/supabase/docker-compose.yml deploy/self-host/bootstrap
```

Expected: no output.

- [ ] **Step 2: Confirm new files are isolated**

Run:

```bash
git diff --name-only main...HEAD | sort
```

Expected output is limited to:

```text
deploy/self-host/README.md
deploy/self-host/all-in-one/Caddyfile.template
deploy/self-host/all-in-one/Dockerfile
deploy/self-host/all-in-one/README.md
deploy/self-host/all-in-one/emqx.conf.template
deploy/self-host/all-in-one/entrypoint.sh
deploy/self-host/all-in-one/healthcheck.sh
deploy/self-host/all-in-one/lib.sh
deploy/self-host/all-in-one/render-config.sh
deploy/self-host/all-in-one/smoke.sh
deploy/self-host/all-in-one/supervisord.conf
docs/superpowers/plans/2026-07-06-self-host-all-in-one.md
docs/superpowers/specs/2026-07-06-self-host-all-in-one-design.md
```

- [ ] **Step 3: Commit verification notes if README changed after fixes**

If verification required README updates, run:

```bash
git add deploy/self-host/README.md deploy/self-host/all-in-one/README.md
git commit -m "docs: update all-in-one verification notes"
```

If no README updates are needed, do not create an empty commit.

---

## Self-review Checklist

- Spec coverage:
  - Single image: Task 7 and Task 10.
  - One port: Task 3, Task 7, Task 11.
  - No external configuration: Task 5 secret generation and Task 4 runtime env rendering.
  - Persistent `/data`: Task 1, Task 5, Task 6, Task 11.
  - MQTT over WebSocket: Task 3, Task 4, Task 11.
  - Existing Compose unchanged: Task 12.
- Placeholder scan: no placeholder markers or intentionally vague task steps remain.
- Type/name consistency:
  - `DATA_DIR`, `RUN_DIR`, and `SECRETS_FILE` are used consistently across scripts.
  - Caddy routes and README routes use `/v1`, `/auth`, `/rest`, `/storage`, `/realtime`, and `/mqtt` consistently.
  - Dockerfile copies scripts/templates into `/opt/teamclaw`, and Task 8 ensures runtime lookup supports both in-repo and in-image execution.
