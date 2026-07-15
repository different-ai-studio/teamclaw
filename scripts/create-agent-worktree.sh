#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/create-agent-worktree.sh <worktree-name> [base-ref]

Examples:
  scripts/create-agent-worktree.sh docs-agent-worktree-flow origin/main
  scripts/create-agent-worktree.sh preview-integration main

Creates .worktrees/<worktree-name> on branch agent/<worktree-name>, then copies
local ignored env/config files required for preview and self-test.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 2
fi

name="$1"
base_ref="${2:-HEAD}"

if [[ ! "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid worktree name: $name" >&2
  echo "Use only letters, numbers, dot, underscore, and dash." >&2
  exit 2
fi

git_common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
repo_root="$(git -C "$git_common_dir/.." rev-parse --show-toplevel)"
worktree_path="$repo_root/.worktrees/$name"
branch_name="agent/$name"

if [[ -e "$worktree_path" ]]; then
  echo "Worktree path already exists: $worktree_path" >&2
  exit 1
fi

git -C "$repo_root" worktree add "$worktree_path" -b "$branch_name" "$base_ref"

copy_if_present() {
  local rel="$1"
  local src="$repo_root/$rel"
  local dst="$worktree_path/$rel"

  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp -p "$src" "$dst"
    echo "copied $rel"
  fi
}

# Root env files are used by release/deploy/backend workflows and ad-hoc tests.
copy_if_present ".env"
copy_if_present ".env.local"

# Web/desktop preview. Vite loads package-local env files for @teamclaw/app.
copy_if_present "packages/app/.env.development.local"

# Daemon onboarding/self-test fallback reads apps/daemon/.env directly.
copy_if_present "apps/daemon/.env"

# Expo local app config, if present on this machine.
copy_if_present "apps/expo/.env"

echo "Created $worktree_path on $branch_name"
