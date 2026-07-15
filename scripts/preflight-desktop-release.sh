#!/usr/bin/env bash
# Pre-release checks for desktop (Tauri) GitHub Release.
# Run from repo root before tagging v*.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0

section() {
  echo ""
  echo "=== $1 ==="
}

warn() {
  echo "⚠ $1"
}

fail() {
  echo "✗ $1"
  FAIL=1
}

ok() {
  echo "✓ $1"
}

section "Desktop version alignment"
if ./scripts/check-desktop-version.sh; then
  DESKTOP_VERSION="$(node -e "console.log(require('./package.json').version)")"
  ok "Release version will be v${DESKTOP_VERSION}"
else
  fail "Fix version mismatch before releasing"
fi

section "Git branch"
BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" == "main" ]]; then
  ok "On main"
else
  warn "Not on main (current: $BRANCH). Tags should be pushed from main after merge."
fi

if git diff --quiet && git diff --cached --quiet; then
  ok "Working tree clean"
else
  warn "Uncommitted changes present — commit or stash before tagging"
fi

section "Production build config"
if [[ -f build.config.json ]]; then
  ok "build.config.json present (local)"
else
  warn "No local build.config.json — CI injects BUILD_CONFIG_PRODUCTION secret"
fi

section "Updater endpoints (tauri.conf.json)"
if command -v jq >/dev/null 2>&1; then
  ENDPOINT_COUNT=0
  while IFS= read -r endpoint; do
    [[ -z "$endpoint" ]] && continue
    ENDPOINT_COUNT=$((ENDPOINT_COUNT + 1))
    if [[ "$endpoint" == *"__OSS_BASE_URL__"* ]]; then
      warn "Placeholder endpoint (resolved at CI build): $endpoint"
    else
      ok "Endpoint: $endpoint"
    fi
  done < <(jq -r '.plugins.updater.endpoints[]? // empty' apps/desktop/tauri.conf.json)
  if [[ "$ENDPOINT_COUNT" -eq 0 ]]; then
    fail "No updater endpoints configured in tauri.conf.json"
  fi
else
  warn "jq not installed — skipping updater endpoint check"
fi

section "Optional local build smoke"
echo "Run manually when validating a release candidate:"
echo "  pnpm verify-release"
echo "  pnpm tauri:build:mac:all    # macOS dual-arch"
echo "  pnpm tauri:build:win        # Windows NSIS (on Windows)"

section "Tag & publish"
if [[ -n "${DESKTOP_VERSION:-}" ]]; then
  echo "After merge to main:"
  echo "  git tag v${DESKTOP_VERSION}"
  echo "  git push origin v${DESKTOP_VERSION}"
  echo ""
  echo "Or re-run a failed release from GitHub Actions → Release → Run workflow (tag: v${DESKTOP_VERSION})."
fi

echo ""
if [[ "$FAIL" -ne 0 ]]; then
  echo "Preflight FAILED — fix errors above before tagging."
  exit 1
fi

echo "Preflight passed (warnings are informational)."
