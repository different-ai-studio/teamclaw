#!/usr/bin/env sh
# Render per-service env files + Caddy/NanoMQ config for SUPABASE mode.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

DATA_DIR="${DATA_DIR:-/data}"
RUN_DIR="${RUN_DIR:-/run/teamclaw}"
SECRETS_FILE="${SECRETS_FILE:-$DATA_DIR/teamclaw/secrets.env}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1:8080}"

find_asset() {
  name="$1"
  if [ -f "$SCRIPT_DIR/$name" ]; then printf '%s\n' "$SCRIPT_DIR/$name"; return 0; fi
  if [ -f "/opt/teamclaw/$name" ]; then printf '%s\n' "/opt/teamclaw/$name"; return 0; fi
  fatal "missing asset: $name"
}

ws_url_from_base() {
  base="$1"
  case "$base" in
    https://*) printf 'wss://%s' "${base#https://}" ;;
    http://*)  printf 'ws://%s'  "${base#http://}" ;;
    *) fatal "PUBLIC_BASE_URL must start with http:// or https://" ;;
  esac
}

[ -f "$SECRETS_FILE" ] || fatal "missing secrets file: $SECRETS_FILE"

ensure_dir "$RUN_DIR/caddy"
ensure_dir "$RUN_DIR/nanomq"
ensure_dir "$RUN_DIR/gotrue"
ensure_dir "$RUN_DIR/postgrest"
ensure_dir "$RUN_DIR/storage"
ensure_dir "$RUN_DIR/fc"

set -a
. "$SECRETS_FILE"
set +a

MQTT_WS_URL="$(ws_url_from_base "$PUBLIC_BASE_URL")/mqtt"

# Raw MQTT TCP rides the same public port via Caddy's layer4 split (see
# Caddyfile.template): non-HTTP bytes on :8080 are proxied to NanoMQ. Derive
# the public TCP URL from the same base. Note: if an external LB terminates
# TLS in front of the container, raw MQTT through it needs that LB to pass
# TCP through — plain http:// deployments work as-is.
MQTT_TCP_HOSTPORT="${PUBLIC_BASE_URL#http://}"
MQTT_TCP_HOSTPORT="${MQTT_TCP_HOSTPORT#https://}"
MQTT_TCP_URL="mqtt://${MQTT_TCP_HOSTPORT%%/*}"

envsubst < "$(find_asset Caddyfile.template)"   > "$RUN_DIR/caddy/Caddyfile"
envsubst < "$(find_asset nanomq.conf.template)" > "$RUN_DIR/nanomq/nanomq.conf"

# ---- GoTrue (:9999) --------------------------------------------------------
cat > "$RUN_DIR/gotrue/env" <<EOF_GOTRUE
GOTRUE_API_HOST=0.0.0.0
GOTRUE_API_PORT=9999
API_EXTERNAL_URL=$PUBLIC_BASE_URL
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:$POSTGRES_PASSWORD@127.0.0.1:5432/postgres
GOTRUE_SITE_URL=$PUBLIC_BASE_URL
GOTRUE_JWT_SECRET=$JWT_SECRET
GOTRUE_JWT_ADMIN_ROLES=service_role
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_JWT_EXP=3600
GOTRUE_EXTERNAL_EMAIL_ENABLED=true
GOTRUE_MAILER_AUTOCONFIRM=true
GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=true
GOTRUE_DISABLE_SIGNUP=false
GOTRUE_EXTERNAL_PHONE_ENABLED=false
GOTRUE_SMTP_HOST=localhost
GOTRUE_SMTP_PORT=2500
GOTRUE_SMTP_USER=fake
GOTRUE_SMTP_PASS=fake
GOTRUE_SMTP_ADMIN_EMAIL=admin@example.com
GOTRUE_SMTP_SENDER_NAME=teamclaw
GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify
GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify
GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify
GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify
EOF_GOTRUE

# ---- PostgREST (:3000) -----------------------------------------------------
cat > "$RUN_DIR/postgrest/env" <<EOF_PGRST
PGRST_DB_URI=postgres://authenticator:$POSTGRES_PASSWORD@127.0.0.1:5432/postgres
PGRST_DB_SCHEMAS=public,storage,graphql_public,amux
PGRST_DB_ANON_ROLE=anon
PGRST_JWT_SECRET=$JWT_SECRET
PGRST_DB_USE_LEGACY_GUCS=false
PGRST_APP_SETTINGS_JWT_SECRET=$JWT_SECRET
PGRST_APP_SETTINGS_JWT_EXP=3600
PGRST_SERVER_HOST=127.0.0.1
PGRST_SERVER_PORT=3000
EOF_PGRST

# ---- storage-api (:5000) ---------------------------------------------------
cat > "$RUN_DIR/storage/env" <<EOF_STORAGE
SERVER_HOST=127.0.0.1
SERVER_PORT=5000
ANON_KEY=$ANON_KEY
SERVICE_KEY=$SERVICE_ROLE_KEY
POSTGREST_URL=http://127.0.0.1:3000
PGRST_JWT_SECRET=$JWT_SECRET
DATABASE_URL=postgres://supabase_storage_admin:$POSTGRES_PASSWORD@127.0.0.1:5432/postgres
DB_INSTALL_ROLES=false
DB_SUPER_USER=postgres
FILE_SIZE_LIMIT=52428800
STORAGE_BACKEND=file
FILE_STORAGE_BACKEND_PATH=/data/storage
TENANT_ID=stub
REGION=stub
GLOBAL_S3_BUCKET=stub
ENABLE_IMAGE_TRANSFORMATION=false
EOF_STORAGE

# ---- FC Cloud API (:9000) — SUPABASE backend ------------------------------
cat > "$RUN_DIR/fc/env" <<EOF_FC
PORT=9000
HOST=127.0.0.1
BACKEND_KIND=supabase
SUPABASE_URL=$PUBLIC_BASE_URL
SUPABASE_PUBLIC_URL=$PUBLIC_BASE_URL
SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
DATABASE_URL=
MQTT_BROKER_URL=mqtt://127.0.0.1:1883
MQTT_PUBLIC_BROKER_URL=$MQTT_WS_URL
MQTT_PUBLIC_TCP_BROKER_URL=$MQTT_TCP_URL
MQTT_USERNAME=fc-service
MQTT_PASSWORD=$MQTT_SERVICE_TOKEN
MQTT_USE_TLS=false
CRON_TRIGGER_SECRET=$CRON_TRIGGER_SECRET
EOF_FC

log "rendered supabase-mode runtime config into $RUN_DIR"
