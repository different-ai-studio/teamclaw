#!/usr/bin/env bash
# Reproduce mid-turn follow-up race against a running local amuxd.
#
# Usage:
#   scripts/repro-mid-turn-followup.sh [--session-id <uuid>]
#
# Requires ~/.amuxd/amuxd.http.{port,token} and an engaged opencode runtime
# for the target session (TeamClu desktop open on that session works).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id)
      SESSION_ID="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$SESSION_ID" ]]; then
  export REPRO_SESSION_ID="$SESSION_ID"
fi

export REPRO_MID_TURN_LIVE=1

echo "==> Client-side simulation (always)"
pnpm --filter @teamclu/app exec vitest run src/lib/__tests__/mid-turn-followup-repro.test.ts -t "client store simulation"

echo ""
echo "==> Live daemon repro (needs mid-turn runtime on session ${REPRO_SESSION_ID:-active-session-id})"
pnpm --filter @teamclu/app exec vitest run src/lib/__tests__/mid-turn-followup-repro.test.ts -t "live daemon"

echo ""
echo "==> Daemon unit: double prompt clears tools_in_flight (cargo test)"
cargo test -p amuxd second_prompt_while_turn_active -- --nocapture
