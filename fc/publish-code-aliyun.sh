#!/usr/bin/env bash
# Publish FC code without Serverless Devs: zip → OSS → UpdateFunction.
# Requires: aliyun CLI, ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET (or source ../.env.local with SLS_*).
set -euo pipefail
cd "$(dirname "$0")"

if [ -f ../.env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source ../.env.local
  set +a
fi
export ALIBABA_CLOUD_ACCESS_KEY_ID="${ALIBABA_CLOUD_ACCESS_KEY_ID:-${SLS_ACCESS_KEY_ID:-}}"
export ALIBABA_CLOUD_ACCESS_KEY_SECRET="${ALIBABA_CLOUD_ACCESS_KEY_SECRET:-${SLS_ACCESS_KEY_SECRET:-}}"

REGION="${FC_REGION:-cn-shenzhen}"
FUNC="${FC_FUNCTION_NAME:-teamclaw-sync}"
BUCKET="${OSS_BUCKET:-teamclaw-team}"
OBJECT="${OSS_CODE_OBJECT:-_deploy/fc-latest.zip}"
ENDPOINT="${OSS_ENDPOINT:-https://oss-${REGION}.aliyuncs.com}"

export NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/}"
npm install --omit=dev --silent

ZIP="$(mktemp -t tcf-code).zip"
trap 'rm -f "$ZIP"' EXIT
zip -qr "$ZIP" index.mjs package.json package-lock.json node_modules

aliyun oss cp "$ZIP" "oss://${BUCKET}/${OBJECT}" --region "$REGION" --endpoint "$ENDPOINT" -f

aliyun fc UpdateFunction --functionName "$FUNC" --region "$REGION" \
  --body "{\"runtime\":\"nodejs20\",\"handler\":\"index.handler\",\"code\":{\"ossBucketName\":\"${BUCKET}\",\"ossObjectName\":\"${OBJECT}\"}}"

echo "Published to ${FUNC} (code object oss://${BUCKET}/${OBJECT})"
