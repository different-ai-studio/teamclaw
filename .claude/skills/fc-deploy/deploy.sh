#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT/fc"

# Load .env if present
if [ -f .env ]; then
  source .env
fi
if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  source "$REPO_ROOT/.env.local"
  set +a
fi

# Normalize names expected by s.yaml / FC runtime
export ACCESS_KEY_ID="${ACCESS_KEY_ID:-${SLS_ACCESS_KEY_ID:-}}"
export ACCESS_KEY_SECRET="${ACCESS_KEY_SECRET:-${SLS_ACCESS_KEY_SECRET:-}}"
export LITELLM_URL="${LITELLM_URL:-${liteLLM_URL:-}}"
export LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-${liteLLM_MASTER_KEY:-}}"
export LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD="${LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD:-${liteLLM_DEFAULT_TEAM_MAX_BUDGET_USD:-}}"
export CODEUP_ORG_ID="${CODEUP_ORG_ID:-}"
export CODEUP_PAT="${CODEUP_PAT:-}"
export CODEUP_BOT_USERNAME="${CODEUP_BOT_USERNAME:-teamclaw}"

# Check required env vars
for var in ACCESS_KEY_ID ACCESS_KEY_SECRET ROLE_ARN; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set" >&2
    exit 1
  fi
done

# Check s CLI
if ! command -v s &>/dev/null; then
  echo "Installing Serverless Devs..."
  npm install -g @serverless-devs/s
fi

# Install dependencies (avoid broken third-party npm mirrors)
export NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/}"
npm install --omit=dev

# Deploy
s deploy -y
