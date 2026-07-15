#!/usr/bin/env sh
# Smoke-test the bundled LiteLLM AI gateway against the running compose stack.
#
# Usage (from deploy/self-host/):
#   sh smoke/litellm-smoke.sh
#
# Checks, in order:
#   1. the _litellm database exists inside the Supabase db container
#   2. the gateway is live
#   3. the frontend tiers (default/pro/max) are served
#   4. the gateway is reachable through Caddy at {FC_DOMAIN}/llm
#
# Does NOT spend upstream tokens: no chat completion is issued. Model presence
# is read from /v1/models.
set -eu

SH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SH_DIR"

[ -f .env ] || { echo "FAIL: $SH_DIR/.env not found"; exit 1; }
KEY="$(grep '^LITELLM_MASTER_KEY=' .env | cut -d= -f2-)"
FC_HOST="$(grep '^FC_DOMAIN=' .env | cut -d= -f2-)"
[ -n "$KEY" ] || { echo "FAIL: LITELLM_MASTER_KEY empty in .env"; exit 1; }

fails=0
ok()  { echo "  PASS  $1"; }
bad() { echo "  FAIL  $1"; fails=$((fails + 1)); }

echo "1. _litellm database inside the Supabase db container"
if docker compose exec -T db psql -U postgres -tAc \
     "SELECT datname FROM pg_database WHERE datname='_litellm'" 2>/dev/null | grep -qx _litellm; then
  ok "_litellm exists (shares the Supabase postgres)"
else
  bad "_litellm database missing — did litellm-init run?"
fi

echo "2. gateway liveliness"
if docker compose exec -T litellm python3 -c \
     "import urllib.request;urllib.request.urlopen('http://localhost:4000/health/liveliness')" 2>/dev/null; then
  ok "/health/liveliness -> 200"
else
  bad "gateway not live"
fi

echo "3. frontend tiers served"
# -w writes the model ids one per line; grep -qx keeps the match exact.
ids="$(docker compose exec -T litellm env K="$KEY" python3 -c \
  'import json,os,urllib.request as u; r=u.Request("http://localhost:4000/v1/models", headers={"Authorization":"Bearer "+os.environ["K"]}); print("\n".join(m["id"] for m in json.load(u.urlopen(r))["data"]))' \
  2>/dev/null || true)"
for m in default pro max; do
  if printf '%s\n' "$ids" | grep -qx "$m"; then ok "model '$m' served"; else bad "model '$m' missing"; fi
done

echo "4. reachable through Caddy at /llm (the public base_url shape)"
# Probed from the host with curl --resolve, not from inside the caddy container:
# its busybox wget has no TLS/SNI, and SNI is what selects the site block.
#
# Match the deployment's TLS mode. With acme/internal Caddy 308-redirects :80 to
# :443 for every path, so an http probe would report a redirect without proving
# /llm routes anywhere. CADDY_SITE_SCHEME is "http://" only when TLS is off.
SITE_SCHEME="$(grep '^CADDY_SITE_SCHEME=' .env | cut -d= -f2- || true)"
if [ "$SITE_SCHEME" = "http://" ]; then
  SCHEME=http; PORT="$(grep '^CADDY_HTTP_PORT=' .env | cut -d= -f2-)"; PORT="${PORT:-80}"
else
  SCHEME=https; PORT="$(grep '^CADDY_HTTPS_PORT=' .env | cut -d= -f2-)"; PORT="${PORT:-443}"
fi
# -k: with CADDY_TLS_MODE=internal the CA is Caddy's own; on acme it is a no-op.
code="$(curl -s -k -o /dev/null -w '%{http_code}' -m 20 \
  --resolve "$FC_HOST:$PORT:127.0.0.1" \
  "$SCHEME://$FC_HOST:$PORT/llm/health/liveliness" || echo "")"
if [ "$code" = "200" ]; then
  ok "GET $SCHEME://$FC_HOST/llm/health/liveliness -> 200"
else
  bad "/llm route -> ${code:-no response} ($SCHEME://$FC_HOST:$PORT/llm/...)"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "litellm-smoke: OK"
else
  echo "litellm-smoke: $fails check(s) failed"
  exit 1
fi
