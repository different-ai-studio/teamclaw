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

# Collect updater endpoints (singular legacy field or endpoints array)
ENDPOINTS=()
while IFS= read -r endpoint; do
    if [ -n "$endpoint" ]; then
        ENDPOINTS+=("$endpoint")
    fi
done < <(
    jq -r '
        (.app.updater.endpoint // empty),
        (.app.updater.endpoints[]? // empty)
    ' build.config.json | awk '!seen[$0]++'
)

if [ "${#ENDPOINTS[@]}" -eq 0 ]; then
    echo "❌ Updater endpoints not configured in build.config.json"
    exit 1
fi
echo "✓ Updater endpoints configured (${#ENDPOINTS[@]}):"
for endpoint in "${ENDPOINTS[@]}"; do
    echo "  - $endpoint"
done

# Check updater pubkey configuration
PUBKEY=$(jq -r '.app.updater.pubkey // empty' build.config.json)
if [ -z "$PUBKEY" ]; then
    echo "❌ Updater pubkey not configured in build.config.json"
    exit 1
fi
echo "✓ Updater pubkey configured"

# Check endpoint reachability and pick the newest manifest version
echo
echo "Testing endpoint connectivity..."
BEST_VERSION=""
BEST_ENDPOINT=""
for endpoint in "${ENDPOINTS[@]}"; do
    HTTP_CODE=$(curl -s -o /tmp/updater-manifest.json -w "%{http_code}" "$endpoint" || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "✓ Endpoint reachable (HTTP $HTTP_CODE): $endpoint"
        VERSION=$(jq -r '.version // empty' /tmp/updater-manifest.json)
        if [ -n "$VERSION" ]; then
            echo "  Latest version: $VERSION"
            if [ -z "$BEST_VERSION" ] || [ "$(printf '%s\n' "$BEST_VERSION" "$VERSION" | sort -V | tail -1)" = "$VERSION" ]; then
                BEST_VERSION="$VERSION"
                BEST_ENDPOINT="$endpoint"
            fi
        else
            echo "  ⚠ Could not parse manifest version"
        fi
    elif [ "$HTTP_CODE" = "000" ]; then
        echo "⚠ Could not connect to endpoint: $endpoint"
    else
        echo "⚠ Endpoint returned HTTP $HTTP_CODE: $endpoint"
    fi
done

if [ -n "$BEST_VERSION" ]; then
    echo
    echo "Newest manifest across endpoints: v$BEST_VERSION ($BEST_ENDPOINT)"
fi

echo
echo "=== Verification Complete ==="
