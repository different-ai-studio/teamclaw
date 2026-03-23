#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Load .env if present
if [ -f .env ]; then
  source .env
fi

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

# Install dependencies
npm install --production

# Deploy
s deploy -y
