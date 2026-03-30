#!/bin/bash
# Verify updater configuration

set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== Updater Configuration Verification ==="
echo

# Check build.config.json exists
if [ ! -f "build.config.json" ]; then
    echo "❌ build.config.json not found"
    exit 1
fi
echo "✓ build.config.json found"

# Check updater endpoint configuration
ENDPOINT=$(jq -r '.app.updater.endpoint // empty' build.config.json)
if [ -z "$ENDPOINT" ]; then
    echo "❌ Updater endpoint not configured in build.config.json"
    exit 1
fi
echo "✓ Updater endpoint configured: $ENDPOINT"

# Check updater pubkey configuration
PUBKEY=$(jq -r '.app.updater.pubkey // empty' build.config.json)
if [ -z "$PUBKEY" ]; then
    echo "❌ Updater pubkey not configured in build.config.json"
    exit 1
fi
echo "✓ Updater pubkey configured"

# Check endpoint is reachable
echo
echo "Testing endpoint connectivity..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$ENDPOINT" || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo "✓ Endpoint is reachable (HTTP $HTTP_CODE)"
elif [ "$HTTP_CODE" = "000" ]; then
    echo "⚠ Could not connect to endpoint (network error)"
else
    echo "⚠ Endpoint returned HTTP $HTTP_CODE"
fi

# Validate manifest format
echo
echo "Validating manifest format..."
MANIFEST=$(curl -s "$ENDPOINT" 2>/dev/null || echo "{}")
VERSION=$(echo "$MANIFEST" | jq -r '.version // empty')
if [ -n "$VERSION" ]; then
    echo "✓ Manifest is valid JSON"
    echo "  Latest version: $VERSION"
else
    echo "⚠ Could not parse manifest or version not found"
fi

echo
echo "=== Verification Complete ==="
