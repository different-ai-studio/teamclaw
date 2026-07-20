#!/usr/bin/env bash
# Verify agent quote-reply data flow:
#   daemon emit → local messages.toml reply_to_message_id
#   client FIFO stamp → adaptTeamclawMessages keeps replyTo on partsJson path
# Starts a freshly built amuxd in the background, runs tests, then stops it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

export CARGO_TARGET_DIR="${ROOT_DIR}/.cargo-target"
export RUST_LOG="${RUST_LOG:-info,amuxd=info}"

AMUXD_BIN="${CARGO_TARGET_DIR}/debug/amuxd"
LOG_DIR="${ROOT_DIR}/logs/dev"
LOG_FILE="${LOG_DIR}/agent-reply-quote-flow.log"
STARTED_BY_US=0

cleanup() {
  if [[ "${STARTED_BY_US}" -eq 1 ]]; then
    echo "==> Stopping amuxd (started by this script)"
    if [[ -x "${AMUXD_BIN}" ]]; then
      "${AMUXD_BIN}" stop >/dev/null 2>&1 || true
    fi
    if [[ -x "${HOME}/.amuxd/bin/amuxd" ]]; then
      "${HOME}/.amuxd/bin/amuxd" stop >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

mkdir -p "${LOG_DIR}"

echo "==> [1/5] Stop any existing amuxd"
if [[ -x "${HOME}/.amuxd/bin/amuxd" ]]; then
  "${HOME}/.amuxd/bin/amuxd" stop >/dev/null 2>&1 || true
fi
if [[ -x "${AMUXD_BIN}" ]]; then
  "${AMUXD_BIN}" stop >/dev/null 2>&1 || true
fi
sleep 1

echo "==> [2/5] Build amuxd"
cargo build -p amuxd

echo "==> [3/5] Start amuxd in background"
STARTED_BY_US=1
# `amuxd start` keeps the parent attached on this build; background + poll status.
nohup "${AMUXD_BIN}" start >>"${LOG_FILE}" 2>&1 </dev/null &
disown || true
for i in $(seq 1 80); do
  status_out="$("${AMUXD_BIN}" status 2>&1 || true)"
  # Avoid matching "not running".
  if echo "${status_out}" | grep -Eq '^amuxd: running'; then
    echo "    ${status_out}"
    break
  fi
  if [[ "${i}" -eq 80 ]]; then
    echo "ERROR: amuxd failed to become ready; status=${status_out}" >&2
    tail -40 "${LOG_FILE}" >&2 || true
    exit 1
  fi
  sleep 0.25
done

echo "==> [4/5] Daemon unit tests (reply_to persist + cloud insert stamp)"
# Single TESTNAME filter matches all three:
#   emit_agent_message_persists_reply_to_message_id
#   insert_message_records_each_call_with_metadata (asserts reply_to)
#   test_to_proto_preserves_reply_to_message_id
cargo test -p amuxd --bin amuxd reply_to -- --nocapture

echo "==> [5/5] Client adapter + FIFO + quote UI tests"
pnpm --filter @teamclaw/app exec vitest run \
  src/lib/__tests__/v2-message-adapter.test.ts \
  src/lib/__tests__/pending-agent-reply-to.test.ts \
  src/components/chat/__tests__/AgentReplyQuote.test.tsx

# Guard: live dock must not wire peekPending / replyQuote anymore
if rg -n "peekPendingAgentReplyTo|replyQuote" \
  packages/app/src/components/chat/ChatPanel.tsx \
  packages/app/src/components/chat/ComposerStack.tsx; then
  echo "ERROR: live dock still references reply quote / peekPending" >&2
  exit 1
fi

echo "==> PASS: agent reply-quote data flow checks succeeded"
