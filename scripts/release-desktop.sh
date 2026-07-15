#!/usr/bin/env bash
# One-click desktop release: bump → Cargo.lock → verify → PR → tag → GitHub Actions Release.
#
# Usage:
#   ./scripts/release-desktop.sh --patch          # 0.2.9 → 0.2.10 (default mode)
#   ./scripts/release-desktop.sh 0.2.10           # explicit semver
#   ./scripts/release-desktop.sh --tag-only       # tag current main version (no bump)
#   ./scripts/release-desktop.sh --tag-only --retag   # delete + recreate tag
#   ./scripts/release-desktop.sh --dry-run --patch
#   ./scripts/release-desktop.sh --patch --yes    # skip confirmation prompts
#   ./scripts/release-desktop.sh --patch --no-tag # stop after PR merge
#
# Requires: git, gh (authenticated), node, pnpm, cargo, jq (optional)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

GITHUB_REPO="${GITHUB_REPO:-different-ai-studio/teamclaw-next}"

MODE="release" # release | tag-only
NEXT_VERSION=""
AUTO_PATCH=0
DRY_RUN=0
YES=0
NO_TAG=0
NO_PR=0
RETAG=0
SKIP_VERIFY=0

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

log() { echo "→ $*"; }
ok() { echo "✓ $*"; }
die() { echo "✗ $*" >&2; exit 1; }

confirm() {
  local prompt="$1"
  if [[ "$YES" -eq 1 || "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] ${prompt} → yes"
    return 0
  fi
  read -r -p "${prompt} [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
    return 0
  fi
  "$@"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --patch) AUTO_PATCH=1; shift ;;
    --tag-only) MODE="tag-only"; shift ;;
    --retag) RETAG=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --no-tag) NO_TAG=1; shift ;;
    --no-pr) NO_PR=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    -*)
      die "Unknown option: $1 (try --help)"
      ;;
    *)
      if [[ -n "$NEXT_VERSION" ]]; then
        die "Unexpected argument: $1"
      fi
      NEXT_VERSION="$1"
      shift
      ;;
  esac
done

for cmd in git gh node pnpm cargo; do
  command -v "$cmd" >/dev/null 2>&1 || die "Missing required command: $cmd"
done

gh auth status >/dev/null 2>&1 || die "gh not authenticated — run: gh auth login"

current_version() {
  node -e "console.log(require('./package.json').version)"
}

patch_bump() {
  node -e "
    const v = require('./package.json').version.split('.').map(Number);
    if (v.length < 3 || v.some(n => Number.isNaN(n))) process.exit(1);
    v[2] += 1;
    console.log(v.join('.'));
  "
}

if [[ "$MODE" == "release" ]]; then
  if [[ -z "$NEXT_VERSION" && "$AUTO_PATCH" -eq 0 ]]; then
    AUTO_PATCH=1
  fi
  if [[ "$AUTO_PATCH" -eq 1 && -z "$NEXT_VERSION" ]]; then
    NEXT_VERSION="$(patch_bump)"
  fi
  [[ -n "$NEXT_VERSION" ]] || die "Provide VERSION or use --patch"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  die "Working tree not clean — commit or stash before releasing"
fi

log "Fetching origin/main…"
run git fetch origin main

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  log "Checking out main (was: ${CURRENT_BRANCH})…"
  run git checkout main
fi
run git pull --ff-only origin main

if [[ "$MODE" == "tag-only" ]]; then
  NEXT_VERSION="$(current_version)"
  ok "Tag-only mode for v${NEXT_VERSION}"
else
  CURRENT="$(current_version)"
  if [[ "$CURRENT" == "$NEXT_VERSION" ]]; then
    die "Already at ${NEXT_VERSION}; use --tag-only to re-tag or pick a higher version"
  fi
  log "Bumping ${CURRENT} → ${NEXT_VERSION}…"
  run node scripts/bump-desktop-version.mjs "$NEXT_VERSION"
  run ./scripts/sync-cargo-lock-version.sh
fi

run ./scripts/check-desktop-version.sh

if [[ "$SKIP_VERIFY" -eq 0 ]]; then
  log "Frontend production build smoke test…"
  run pnpm --filter @teamclaw/app build
  ok "Frontend build passed"
else
  echo "⚠ Skipping frontend build (--skip-verify)"
fi

run ./scripts/preflight-desktop-release.sh

if [[ "$MODE" == "release" ]]; then
  BRANCH="chore/desktop-release-${NEXT_VERSION}"
  log "Creating branch ${BRANCH}…"
  run git checkout -b "$BRANCH"

  run git add \
    package.json \
    apps/desktop/Cargo.toml \
    apps/desktop/tauri.conf.json \
    apps/daemon/Cargo.toml \
    Cargo.lock

  COMMIT_MSG="chore(desktop): bump version to ${NEXT_VERSION}"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] git commit -m \"${COMMIT_MSG}\""
  else
    git commit -m "$(cat <<EOF
${COMMIT_MSG}

Sync Cargo.lock for teamclaw/amuxd so Release sidecar builds pass with --locked.
EOF
)"
  fi
  ok "Committed version bump"

  if [[ "$NO_PR" -eq 1 ]]; then
    echo ""
    echo "Stopped with --no-pr. Next steps:"
    echo "  git push -u origin ${BRANCH}"
    echo "  gh pr create --base main --title \"release(desktop): v${NEXT_VERSION}\""
    echo "  # after merge:"
    echo "  ./scripts/release-desktop.sh --tag-only"
    exit 0
  fi

  confirm "Push branch and open PR for v${NEXT_VERSION}?" || die "Aborted before PR"
  run git push -u origin "$BRANCH"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] gh pr create + gh pr merge"
  else
    PR_URL="$(gh pr create --repo "$GITHUB_REPO" --base main --head "$BRANCH" \
      --title "release(desktop): v${NEXT_VERSION}" \
      --body "$(cat <<EOF
## Summary

Automated desktop release bump **→ v${NEXT_VERSION}** via \`scripts/release-desktop.sh\`.

- Version sources + \`Cargo.lock\` (teamclaw/amuxd) aligned
- Local frontend build + preflight passed

## Test plan

- [ ] CI green on PR
- [ ] Tag \`v${NEXT_VERSION}\` triggers Release workflow
- [ ] GitHub Release assets published (macOS DMG + Windows NSIS)
EOF
)")"
    ok "PR opened: ${PR_URL}"
    confirm "Squash-merge PR now?" || die "Aborted before merge — merge PR manually, then: ./scripts/release-desktop.sh --tag-only"
    gh pr merge --repo "$GITHUB_REPO" --squash --delete-branch "$(basename "$PR_URL")"
    ok "PR merged"
  fi

  run git checkout main
  run git pull --ff-only origin main
fi

TAG="v${NEXT_VERSION}"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  if [[ "$RETAG" -eq 1 ]]; then
    log "Deleting existing tag ${TAG}…"
    run git tag -d "$TAG" 2>/dev/null || true
    if [[ "$DRY_RUN" -eq 0 ]]; then
      git push origin ":refs/tags/${TAG}" 2>/dev/null || true
    else
      echo "[dry-run] git push origin :refs/tags/${TAG}"
    fi
  else
    die "Tag ${TAG} already exists — use --retag to recreate"
  fi
fi

if [[ "$NO_TAG" -eq 1 ]]; then
  echo ""
  ok "Release prep complete for ${NEXT_VERSION}"
  echo "Tag manually when ready:"
  echo "  git tag ${TAG} && git push origin ${TAG}"
  exit 0
fi

confirm "Create and push tag ${TAG} to trigger Release CI?" || die "Aborted before tag"
run git tag "$TAG"
run git push origin "$TAG"
ok "Tag ${TAG} pushed — Release workflow starting"

if [[ "$DRY_RUN" -eq 0 ]]; then
  sleep 3
  RUN_ID="$(gh run list --repo "$GITHUB_REPO" --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
  echo ""
  echo "Monitor:"
  echo "  gh run watch ${RUN_ID} --repo ${GITHUB_REPO}"
  echo ""
  echo "Release page (when ready):"
  echo "  https://github.com/${GITHUB_REPO}/releases/tag/${TAG}"
fi
