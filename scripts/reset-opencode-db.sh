#!/usr/bin/env bash
# Reset OpenCode's local SQLite DB after schema/version drift.
#
# Default behavior is safe: move opencode.db, opencode.db-wal, and
# opencode.db-shm into a timestamped backup directory. Config under
# ~/.config/opencode and binaries under ~/.opencode are untouched.
#
# Usage:
#   scripts/reset-opencode-db.sh
#   scripts/reset-opencode-db.sh --delete   # permanently remove DB files
set -euo pipefail

MODE="backup"
if [[ "${1:-}" == "--delete" ]]; then
  MODE="delete"
elif [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
elif [[ -n "${1:-}" ]]; then
  echo "error: unknown option: $1" >&2
  echo "usage: $0 [--delete]" >&2
  exit 1
fi

OPENCODE_DATA_DIR="${OPENCODE_DATA_DIR:-$HOME/.local/share/opencode}"
DB_GLOB=(
  "${OPENCODE_DATA_DIR}/opencode.db"
  "${OPENCODE_DATA_DIR}/opencode.db-wal"
  "${OPENCODE_DATA_DIR}/opencode.db-shm"
)

existing=()
for path in "${DB_GLOB[@]}"; do
  if [[ -e "$path" ]]; then
    existing+=("$path")
  fi
done

if [[ "${#existing[@]}" -eq 0 ]]; then
  echo "No OpenCode DB files found under ${OPENCODE_DATA_DIR}."
  exit 0
fi

echo "OpenCode DB files:"
printf '  %s\n' "${existing[@]}"

if [[ "$MODE" == "delete" ]]; then
  rm -f "${existing[@]}"
  echo "Deleted OpenCode DB files. OpenCode will recreate the DB on next start."
  exit 0
fi

backup_dir="${OPENCODE_DATA_DIR}/backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
mv "${existing[@]}" "$backup_dir/"

echo "Moved OpenCode DB files to:"
echo "  ${backup_dir}"
echo "OpenCode will recreate the DB on next start."
