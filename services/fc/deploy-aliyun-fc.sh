#!/usr/bin/env bash
#
# deploy-aliyun-fc.sh — Manual, LOCAL deploy of services/fc to a NON-production
# Function Compute function for testing the Alibaba FC deploy path.
#
# ⚠️  This script is intentionally strict:
#       - refuses to deploy to `teamclaw-sync` unless explicitly forced
#       - requires an explicit env file (no implicit/stale .env)
#       - prints the target + a confirmation prompt before `s deploy`
#
# Usage:
#   ./deploy-aliyun-fc.sh <function-name> [env-file]
#
# Examples:
#   ./deploy-aliyun-fc.sh teamclaw-api-test                 # uses .env.test.local
#   ./deploy-aliyun-fc.sh teamclaw-api-test .env.staging.local
#
# The env file must define (at minimum):
#   ACCESS_KEY_ID, ACCESS_KEY_SECRET   (Aliyun credentials)
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
#   PUSH_WEBHOOK_SECRET, APNS_*, MQTT_*   (see .env.test.example)
#
set -euo pipefail

cd "$(dirname "$0")"

FUNCTION_NAME="${1:-}"
ENV_FILE="${2:-.env.test.local}"

if [ -z "$FUNCTION_NAME" ]; then
  echo "ERROR: function name required." >&2
  echo "Usage: ./deploy-aliyun-fc.sh <function-name> [env-file]" >&2
  exit 1
fi

if [ "$FUNCTION_NAME" = "teamclaw-sync" ] && [ "${FORCE:-}" != "1" ]; then
  echo "ERROR: refusing to deploy to 'teamclaw-sync' without FORCE=1." >&2
  echo "       Set FORCE=1 only when you intend to update the shared function." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file '$ENV_FILE' not found." >&2
  echo "       Copy .env.test.example to '$ENV_FILE' and fill in test values." >&2
  exit 1
fi

# Load the env file (every var becomes an exported process env var, which is
# what Serverless Devs / s.yaml's \${env(...)} reads).
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${ACCESS_KEY_ID:?ACCESS_KEY_ID missing in $ENV_FILE}"
: "${ACCESS_KEY_SECRET:?ACCESS_KEY_SECRET missing in $ENV_FILE}"

# Serverless Devs' ${env('X')} aborts when X is empty OR unset ("not found").
# s.yaml marks several push/MQTT vars as required (no default). For a deploy
# smoke test these don't need real values, so backfill harmless placeholders
# when left blank. (Runtime push/MQTT-auth will be non-functional — expected.)
_backfilled=""
for _v in APNS_PRIVATE_KEY_P8 APNS_KEY_ID APNS_TEAM_ID APNS_TOPIC APNS_ENV \
          MQTT_USERNAME MQTT_PASSWORD; do
  if [ -z "${!_v:-}" ]; then
    printf -v "$_v" '%s' "test-placeholder"
    export "$_v"
    _backfilled="$_backfilled $_v"
  fi
done
[ -n "$_backfilled" ] && echo "NOTE: backfilled empty test vars with placeholders:$_backfilled"

# Tell s.yaml which function to deploy.
export FC_FUNCTION_NAME="$FUNCTION_NAME"
export BACKEND_KIND="${BACKEND_KIND:-supabase}"
# Adopt a pre-existing function's http trigger by name (FC console default is
# `defaultTrigger`). Override via FC_HTTP_TRIGGER_NAME=... in the environment.
export FC_HTTP_TRIGGER_NAME="${FC_HTTP_TRIGGER_NAME:-http-trigger}"

echo "────────────────────────────────────────────────────────"
echo "  LOCAL FC deploy (TEST)"
echo "  function : $FUNCTION_NAME"
echo "  region   : cn-shenzhen  (from s.yaml)"
echo "  backend  : $BACKEND_KIND"
echo "  http trig: $FC_HTTP_TRIGGER_NAME"
echo "  env file : $ENV_FILE"
echo "  supabase : ${SUPABASE_URL:-<unset>}"
echo "────────────────────────────────────────────────────────"
read -r -p "Deploy '$FUNCTION_NAME' with the above config? [y/N] " ans
case "$ans" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 0 ;;
esac

# ── Database migrations ──────────────────────────────────────────────────────
# Run pending SQL migrations from services/supabase/migrations/ before deploy.
# Requires DATABASE_URL (public endpoint) to be set in the env file.
# Skipped when DATABASE_URL is empty (e.g. supabase-only deploys with no RDS).
MIGRATIONS_DIR="$(dirname "$0")/../supabase/migrations"
if [ -n "${DATABASE_URL:-}" ]; then
  echo "==> Running database migrations"
  if ! command -v psql >/dev/null 2>&1; then
    echo "ERROR: psql not found. Install postgresql-client to run migrations." >&2
    exit 1
  fi
  # Only apply incremental migrations (skip the baseline squash file).
  for migration in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | grep -v baseline | sort); do
    filename="$(basename "$migration")"
    echo "    applying: $filename"
    psql "$DATABASE_URL" -f "$migration" 2>&1 | grep -v "^$" || true
  done
  echo "    migrations done."
else
  echo "NOTE: DATABASE_URL not set — skipping database migrations."
fi

command -v s >/dev/null 2>&1 || npm install -g @serverless-devs/s

echo "==> Configuring Aliyun access (default profile)"
s config add \
  --AccessKeyID "$ACCESS_KEY_ID" \
  --AccessKeySecret "$ACCESS_KEY_SECRET" \
  -a default -f

echo "==> Installing dependencies"
npm install

echo "==> Building TypeScript (-> dist/)"
npm run build

# NOTE: the GitHub Action additionally runs `npm prune --omit=dev` to shrink the
# package. Skipped here so your local node_modules stays intact for dev. The
# extra dev deps in the package are harmless for a test deploy.

echo "==> Deploying $FUNCTION_NAME"
s deploy -y

echo "✅ Done. Deployed function: $FUNCTION_NAME"
