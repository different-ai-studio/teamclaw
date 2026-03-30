#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Load .env if present
if [ -f .env ]; then
  # shellcheck disable=SC1091
  source .env
fi
# Repo-root .env.local (gitignored): SLS_* keys, liteLLM_*, optional ROLE_ARN
if [ -f ../.env.local ]; then
  # shellcheck disable=SC1091
  set -a
  source ../.env.local
  set +a
fi

# Normalize names expected by s.yaml / FC runtime
export ACCESS_KEY_ID="${ACCESS_KEY_ID:-${SLS_ACCESS_KEY_ID:-}}"
export ACCESS_KEY_SECRET="${ACCESS_KEY_SECRET:-${SLS_ACCESS_KEY_SECRET:-}}"
export LITELLM_URL="${LITELLM_URL:-${liteLLM_URL:-}}"
export LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-${liteLLM_MASTER_KEY:-}}"
export LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD="${LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD:-${liteLLM_DEFAULT_TEAM_MAX_BUDGET_USD:-}}"

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

# Deploy (requires: s config add --AccessKeyID … --AccessKeySecret … --AccountID …)
# If this fails with "Not found access: default", run the config command once, or publish
# code with: zip + aliyun oss cp to oss://teamclaw-team/_deploy/fc-latest.zip then
# aliyun fc UpdateFunction --functionName teamclaw-sync --region cn-shenzhen \
#   --body '{"runtime":"nodejs20","handler":"index.handler","code":{"ossBucketName":"teamclaw-team","ossObjectName":"_deploy/fc-latest.zip"}}'
s deploy -y
