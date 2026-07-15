#!/bin/sh
# Entrypoint for the self-host amuxd daemon.
#
# On first start (no backend.toml yet) it claims a team invite using
# $AMUXD_JOIN_TOKEN, persisting identity under $HOME/.amuxd. Subsequent
# starts reuse the persisted identity and skip the claim.
set -eu

STATE_DIR="${HOME:-/state}/.amuxd"
mkdir -p "$STATE_DIR"

CLOUD_API_URL="${TEAMCLAW_CLOUD_API_URL:-http://fc:9000}"
export TEAMCLAW_CLOUD_API_URL="$CLOUD_API_URL"

if [ ! -f "$STATE_DIR/backend.toml" ]; then
  if [ -z "${AMUXD_JOIN_TOKEN:-}" ]; then
    echo "amuxd: no persisted identity and AMUXD_JOIN_TOKEN is empty." >&2
    echo "amuxd: mint a daemon invite (deploy/self-host/amuxd/mint-invite.sh)," >&2
    echo "amuxd: set AMUXD_JOIN_TOKEN in deploy/self-host/.env, then recreate this service." >&2
    exit 1
  fi
  echo "amuxd: claiming team invite against $CLOUD_API_URL ..."
  amuxd init "amux://invite?token=${AMUXD_JOIN_TOKEN}&cloud_api_url=${CLOUD_API_URL}"
  echo "amuxd: invite claimed; identity persisted under $STATE_DIR"
else
  echo "amuxd: existing identity found in $STATE_DIR; skipping invite claim"
fi

# ── opencode LLM provider ─────────────────────────────────────────────────────
# If an LLM key is provided, configure opencode with a single OpenAI-compatible
# provider (base URL + key + model) and let the daemon auto-discover opencode so
# it can run agent sessions. Without a key, keep discovery OFF (presence-only):
# opencode with no provider can't run, so we don't advertise it.
if [ -n "${OPENCODE_API_KEY:-}" ]; then
  PROVIDER_ID="${OPENCODE_PROVIDER_ID:-selfhost}"
  PROVIDER_NAME="${OPENCODE_PROVIDER_NAME:-Self-host LLM}"
  MODEL="${OPENCODE_MODEL:?OPENCODE_MODEL must be set when OPENCODE_API_KEY is set}"
  BASE_URL="${OPENCODE_BASE_URL:?OPENCODE_BASE_URL must be set when OPENCODE_API_KEY is set}"
  OC_CFG_DIR="${HOME:-/state}/.config/opencode"
  mkdir -p "$OC_CFG_DIR"
  # Write via a tiny JSON emitter (values already in scope; printf keeps them quoted).
  opencode_cfg() {
    printf '{\n'
    printf '  "$schema": "https://opencode.ai/config.json",\n'
    printf '  "provider": {\n'
    printf '    "%s": {\n' "$PROVIDER_ID"
    printf '      "npm": "@ai-sdk/openai-compatible",\n'
    printf '      "name": "%s",\n' "$PROVIDER_NAME"
    printf '      "options": { "baseURL": "%s", "apiKey": "%s" },\n' "$BASE_URL" "$OPENCODE_API_KEY"
    printf '      "models": { "%s": {} }\n' "$MODEL"
    printf '    }\n'
    printf '  },\n'
    printf '  "model": "%s/%s"\n' "$PROVIDER_ID" "$MODEL"
    printf '}\n'
  }
  opencode_cfg > "$OC_CFG_DIR/opencode.json"
  chmod 600 "$OC_CFG_DIR/opencode.json"
  unset AMUXD_NO_AUTO_DISCOVER
  echo "amuxd: opencode configured (provider=$PROVIDER_ID model=$MODEL baseURL=$BASE_URL); agent discovery enabled"
else
  export AMUXD_NO_AUTO_DISCOVER=1
  echo "amuxd: no OPENCODE_API_KEY — agent discovery disabled (presence-only)"
fi

echo "amuxd: starting daemon ..."
exec amuxd start
