#!/usr/bin/env bash
# Build and publish an OpenCode CLI release from different-ai-studio/opencode.
#
# Local (current platform only):
#   scripts/release-opencode-fork.sh
#
# Full multi-platform release (requires gh + repo admin):
#   scripts/release-opencode-fork.sh --trigger-ci 1.17.7
#
# Env:
#   OPENCODE_FORK_REPO   default: different-ai-studio/opencode
#   OPENCODE_FORK_BRANCH default: dev
#   OPENCODE_VERSION     default: read from packages/opencode/package.json in clone

set -euo pipefail

REPO="${OPENCODE_FORK_REPO:-different-ai-studio/opencode}"
BRANCH="${OPENCODE_FORK_BRANCH:-dev}"
TRIGGER_CI=0
VERSION="${OPENCODE_VERSION:-}"

usage() {
  cat <<EOF
Usage:
  $0 [--trigger-ci VERSION] [VERSION]

  Build OpenCode from https://github.com/${REPO} and upload release assets.

Examples:
  $0                          # build native platform + create/upload release
  $0 1.17.7                   # same, explicit version
  $0 --trigger-ci 1.17.7      # dispatch GitHub Actions for all platforms
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --trigger-ci)
      TRIGGER_CI=1
      shift
      VERSION="${1:-}"
      shift || true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      VERSION="$1"
      shift
      ;;
  esac
done

if [[ "$TRIGGER_CI" -eq 1 ]]; then
  [[ -n "$VERSION" ]] || { echo "Error: version required with --trigger-ci" >&2; exit 1; }
  tag="v${VERSION#v}"
  echo "→ Ensuring release tag ${tag} exists on ${REPO}"
  gh release view "$tag" --repo "$REPO" >/dev/null 2>&1 || \
    gh release create "$tag" --repo "$REPO" --title "$tag (TeamClaw fork)" --notes "Multi-platform CLI build from \`${BRANCH}\`."
  echo "→ Dispatching release-cli workflow"
  gh workflow run release-cli --repo "$REPO" -f "version=${VERSION#v}-teamclaw" -f "tag=${tag}"
  echo "✓ Workflow started. Track: https://github.com/${REPO}/actions/workflows/release-cli.yml"
  exit 0
fi

WORKDIR="${TMPDIR:-/tmp}/opencode-release-$$"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

echo "→ Cloning ${REPO}@${BRANCH}"
git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$WORKDIR/repo"

ROOT_PKG="$WORKDIR/repo/package.json"
PKG_JSON="$WORKDIR/repo/packages/opencode/package.json"
if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require('${PKG_JSON}').version")"
fi
TAG="v${VERSION#v}"

need_bun="$(node -p "require('${ROOT_PKG}').packageManager.split('@')[1]")"
if ! command -v bun >/dev/null 2>&1 || ! bun --version 2>/dev/null | grep -q "^${need_bun%%.*}\."; then
  echo "→ Installing bun ${need_bun}"
  curl -fsSL https://bun.sh/install | bash -s -- "bun-v${need_bun}"
  export PATH="${HOME}/.bun/bin:${PATH}"
fi

echo "→ bun install (may take a few minutes)"
(cd "$WORKDIR/repo" && bun install)

echo "→ Building opencode for $(uname -s)/$(uname -m) (version ${VERSION})"
MARKER_VERSION="${VERSION#v}-teamclaw"
(cd "$WORKDIR/repo/packages/opencode" && OPENCODE_VERSION="$MARKER_VERSION" bun run script/build.ts --single)

DIST="$WORKDIR/repo/packages/opencode/dist"
mapfile -t BUILT_DIRS < <(find "$DIST" -mindepth 1 -maxdepth 1 -type d -name 'opencode-*')
if (( ${#BUILT_DIRS[@]} != 1 )); then
  echo "Error: expected one build output under ${DIST}" >&2
  ls -la "$DIST" >&2 || true
  exit 1
fi

BUILT_NAME="$(basename "${BUILT_DIRS[0]}")"
ASSET=""
PACK=""
case "$BUILT_NAME" in
  opencode-darwin-arm64)  ASSET="opencode-darwin-arm64.zip"; PACK=zip ;;
  opencode-darwin-x64)    ASSET="opencode-darwin-x64.zip"; PACK=zip ;;
  opencode-linux-arm64)   ASSET="opencode-linux-arm64.tar.gz"; PACK=tgz ;;
  opencode-linux-x64)     ASSET="opencode-linux-x64.tar.gz"; PACK=tgz ;;
  opencode-windows-*)     ASSET="${BUILT_NAME}.zip"; PACK=zip ;;
  *)
    echo "Error: unknown build dir ${BUILT_NAME}" >&2
    exit 1
    ;;
esac

OUT="$DIST/$ASSET"
BIN_DIR="${BUILT_DIRS[0]}/bin"
case "$PACK" in
  zip)
    (cd "$BIN_DIR" && zip -j "$OUT" opencode opencode.exe 2>/dev/null || zip -j "$OUT" opencode)
    ;;
  tgz)
    tar -czf "$OUT" -C "$BIN_DIR" opencode
    ;;
esac

echo "→ Packaged ${OUT} ($(du -h "$OUT" | cut -f1))"

echo "→ Uploading to https://github.com/${REPO}/releases/tag/${TAG}"
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || \
  gh release create "$TAG" --repo "$REPO" --title "${TAG} (TeamClaw fork)" \
    --notes "CLI build from \`${BRANCH}\` @ $(git -C "$WORKDIR/repo" rev-parse --short HEAD)."

gh release upload "$TAG" "$OUT" --clobber --repo "$REPO"

echo "✓ Release: https://github.com/${REPO}/releases/tag/${TAG}"
echo "  asset: ${ASSET}"
echo ""
echo "Users can install with:"
echo "  OPENCODE_RELEASE_TAG=${TAG} curl -fsSL https://raw.githubusercontent.com/different-ai-studio/teamclaw-next/main/scripts/install-opencode-fork.sh | bash"
