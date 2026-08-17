#!/bin/sh
# Entrypoint for the self-host amuxd daemon.
#
# On first start (no persisted identity yet) it claims a team invite using
# $AMUXD_JOIN_TOKEN, persisting identity under $HOME/.amuxd. Subsequent
# starts reuse the persisted identity and skip the claim.
set -eu

STATE_DIR="${HOME:-/state}/.amuxd"
mkdir -p "$STATE_DIR"

CLOUD_API_URL="${TEAMCLU_CLOUD_API_URL:-http://fc:9000}"
export TEAMCLU_CLOUD_API_URL="$CLOUD_API_URL"

# Has this daemon already been claimed?
#
# The credentials live at `teams/<team_id>/state/backend.toml` (see
# `provider_config.rs`), so the team id is part of the path and this cannot be a
# fixed filename. Home-layout v2 moved the file there; the guard used to check
# `$STATE_DIR/backend.toml`, the v1 location, which nothing writes any more.
# A stale guard does not fail loudly — it re-runs `amuxd init` on *every* start,
# and since an invite is single-use, the second start onwards dies with
# "invite already consumed" and the container crash-loops.
#
# `_unclaimed` is excluded on purpose: it is where an unclaimed daemon's writes
# land, so its presence is not evidence of a claim.
has_identity() {
  for f in "$STATE_DIR"/teams/*/state/backend.toml; do
    [ -f "$f" ] || continue
    case "$f" in
      "$STATE_DIR"/teams/_unclaimed/*) continue ;;
    esac
    return 0
  done
  return 1
}

if ! has_identity; then
  if [ -z "${AMUXD_JOIN_TOKEN:-}" ]; then
    echo "amuxd: no persisted identity and AMUXD_JOIN_TOKEN is empty." >&2
    echo "amuxd: mint a daemon invite (deploy/self-host/amuxd/mint-invite.sh)," >&2
    echo "amuxd: set AMUXD_JOIN_TOKEN in deploy/self-host/.env, then recreate this service." >&2
    exit 1
  fi
  echo "amuxd: claiming team invite against $CLOUD_API_URL ..."
  amuxd init "amux://invite?token=${AMUXD_JOIN_TOKEN}&cloud_api_url=${CLOUD_API_URL}"
  echo "amuxd: invite claimed; identity persisted under $STATE_DIR"
  # A claim that reports success but leaves no credentials would otherwise be
  # discovered one restart later, as a crash loop against a spent invite.
  if ! has_identity; then
    echo "amuxd: claim reported success but no backend.toml was written under" >&2
    echo "amuxd: $STATE_DIR/teams/<team_id>/state/ — refusing to start." >&2
    exit 1
  fi
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
