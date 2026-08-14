#!/usr/bin/env bash
# Integration checks for scripts/reset-local-state.sh against amuxd home-layout v2.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESET="${SCRIPT_DIR}/reset-local-state.sh"
failures=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: ${label}" >&2
    echo "  expected: ${expected}" >&2
    echo "  actual:   ${actual}" >&2
    failures=$((failures + 1))
  else
    echo "ok: ${label}"
  fi
}

assert_exists() {
  local label="$1" path="$2"
  if [[ -e "$path" || -L "$path" ]]; then
    echo "ok: ${label}"
  else
    echo "FAIL: ${label} — missing ${path}" >&2
    failures=$((failures + 1))
  fi
}

assert_absent() {
  local label="$1" path="$2"
  if [[ -e "$path" || -L "$path" ]]; then
    echo "FAIL: ${label} — still present ${path}" >&2
    failures=$((failures + 1))
  else
    echo "ok: ${label}"
  fi
}

seed_webkit_localstorage() {
  local root="$1" app_id="$2" prefix="$3"
  local db_dir db
  db_dir="${root}/Library/WebKit/${app_id}/WebsiteData/Default/fixture/LocalStorage"
  mkdir -p "$db_dir"
  db="${db_dir}/localstorage.sqlite3"
  sqlite3 "$db" <<SQL
CREATE TABLE ItemTable (key TEXT PRIMARY KEY NOT NULL UNIQUE, value TEXT NOT NULL);
INSERT INTO ItemTable VALUES ('${prefix}-setup-ok', '1');
INSERT INTO ItemTable VALUES ('${prefix}-onboarding-done', '1');
INSERT INTO ItemTable VALUES ('${prefix}-onboarding-role', 'developer');
INSERT INTO ItemTable VALUES ('${prefix}-welcome-seen', 't');
INSERT INTO ItemTable VALUES ('${prefix}.session.v1', '{"access_token":"x"}');
SQL
}

setup_fixture() {
  local root="$1"
  mkdir -p \
    "${root}/.amuxd/teams/t1/shared/teamclu-team" \
    "${root}/.amuxd-copilot361/teams/t2/shared/teamclu-team" \
    "${root}/.copilot361/secrets" \
    "${root}/.teamclu/secrets" \
    "${root}/ws-copilot/.copilot361" \
    "${root}/ws-official/.teamclu" \
    "${root}/Library/WebKit"

  ln -s "${root}/.amuxd-copilot361/teams/t2/shared/teamclu-team" \
    "${root}/ws-copilot/teamclu-team"
  ln -s "${root}/.amuxd/teams/t1/shared/teamclu-team" \
    "${root}/ws-official/teamclu-team"
  # Misnamed brand-prefixed link that old script versions looked for — must NOT
  # be required for cleanup of the real teamclu-team link.
  ln -s "${root}/.amuxd-copilot361/teams/t2/shared/teamclu-team" \
    "${root}/ws-copilot/copilot361-team"

  seed_webkit_localstorage "$root" "com.copilot361.app" "copilot361"
  seed_webkit_localstorage "$root" "com.teamclu.app" "teamclu"
}

# --- brand-scoped reset must not wipe the other brand's daemon home ----------
tmp="$(mktemp -d "${TMPDIR:-/tmp}/reset-local-XXXXXX")"
unrelated_amuxd_pid=""
target_amuxd_pid=""
trap 'if [[ -n "$unrelated_amuxd_pid" ]]; then kill "$unrelated_amuxd_pid" 2>/dev/null || true; fi; if [[ -n "$target_amuxd_pid" ]]; then kill "$target_amuxd_pid" 2>/dev/null || true; fi; rm -rf "$tmp"' EXIT
setup_fixture "$tmp"

# A scoped white-label reset must ignore another brand's live daemon. Model the
# official daemon with its own home PID file; the process name is still amuxd.
mkdir -p "${tmp}/.amuxd/run"
ln -s "$(command -v sleep)" "${tmp}/amuxd"
"${tmp}/amuxd" 30 &
unrelated_amuxd_pid=$!
printf '%s\n' "$unrelated_amuxd_pid" > "${tmp}/.amuxd/run/amuxd.pid"
mkdir -p "${tmp}/target-bin" "${tmp}/.amuxd-copilot361/run"
ln -s "$(command -v sleep)" "${tmp}/target-bin/amuxd"
"${tmp}/target-bin/amuxd" 30 &
target_amuxd_pid=$!
printf '%s\n' "$target_amuxd_pid" > "${tmp}/.amuxd-copilot361/run/amuxd.pid"

HOME="$tmp" "$RESET" -y \
  --short-name copilot361 \
  --app-id com.copilot361.app \
  --workspace "${tmp}/ws-copilot" \
  --keep-opencode \
  >/dev/null

assert_absent "scoped reset removes white-label amuxd home" "${tmp}/.amuxd-copilot361"
if kill -0 "$target_amuxd_pid" 2>/dev/null; then
  echo "FAIL: scoped reset left targeted daemon running" >&2
  failures=$((failures + 1))
else
  echo "ok: scoped reset stops targeted daemon by home pid"
fi
wait "$target_amuxd_pid" 2>/dev/null || true
target_amuxd_pid=""
assert_exists "scoped reset keeps official ~/.amuxd" "${tmp}/.amuxd"
if kill -0 "$unrelated_amuxd_pid" 2>/dev/null; then
  echo "ok: scoped reset keeps other brand daemon running"
else
  echo "FAIL: scoped reset stopped other brand daemon" >&2
  failures=$((failures + 1))
fi
kill "$unrelated_amuxd_pid" 2>/dev/null || true
wait "$unrelated_amuxd_pid" 2>/dev/null || true
unrelated_amuxd_pid=""
assert_exists "scoped reset keeps official ~/.teamclu" "${tmp}/.teamclu"
assert_absent "scoped reset removes brand home" "${tmp}/.copilot361"
assert_absent "scoped reset removes fixed teamclu-team symlink" "${tmp}/ws-copilot/teamclu-team"
assert_absent "scoped reset still cleans misnamed brand-team symlink" "${tmp}/ws-copilot/copilot361-team"
assert_exists "scoped reset keeps workspace meta of other brands only if not targeted" "${tmp}/ws-official/teamclu-team"
assert_absent "scoped reset removes white-label WebKit profile" "${tmp}/Library/WebKit/com.copilot361.app"
assert_exists "scoped reset keeps official WebKit profile" "${tmp}/Library/WebKit/com.teamclu.app"
# AuthGate skips first-run when setup-ok=1 — scoped wipe must clear the brand's key.
if [[ -f "${tmp}/Library/WebKit/com.teamclu.app/WebsiteData/Default/fixture/LocalStorage/localstorage.sqlite3" ]]; then
  remaining="$(sqlite3 "${tmp}/Library/WebKit/com.teamclu.app/WebsiteData/Default/fixture/LocalStorage/localstorage.sqlite3" \
    "SELECT value FROM ItemTable WHERE key='teamclu-setup-ok';" 2>/dev/null || true)"
  assert_eq "scoped reset leaves other brand setup-ok untouched" "1" "$remaining"
fi

# --- full reset clears both homes and fixed team links -----------------------
tmp2="$(mktemp -d "${TMPDIR:-/tmp}/reset-local-XXXXXX")"
setup_fixture "$tmp2"

HOME="$tmp2" "$RESET" -y \
  --workspace "${tmp2}/ws-copilot" \
  --workspace "${tmp2}/ws-official" \
  --keep-opencode \
  >/dev/null

assert_absent "full reset removes official ~/.amuxd" "${tmp2}/.amuxd"
assert_absent "full reset removes white-label amuxd home" "${tmp2}/.amuxd-copilot361"
assert_absent "full reset removes official teamclu-team link" "${tmp2}/ws-official/teamclu-team"
assert_absent "full reset removes white-label workspace teamclu-team link" "${tmp2}/ws-copilot/teamclu-team"
assert_absent "full reset removes official WebKit (setup-ok / session)" "${tmp2}/Library/WebKit/com.teamclu.app"
assert_absent "full reset removes white-label WebKit" "${tmp2}/Library/WebKit/com.copilot361.app"

# --- key purge still works when the WebKit dir cannot be deleted wholesale ----
tmp3="$(mktemp -d "${TMPDIR:-/tmp}/reset-local-XXXXXX")"
seed_webkit_localstorage "$tmp3" "com.teamclu.app" "teamclu"
db3="${tmp3}/Library/WebKit/com.teamclu.app/WebsiteData/Default/fixture/LocalStorage/localstorage.sqlite3"
# Simulate an in-use profile: directory not writable (rm -rf cannot empty it),
# but the sqlite file itself remains readable/writable for key purge.
chmod 555 \
  "${tmp3}/Library/WebKit/com.teamclu.app" \
  "${tmp3}/Library/WebKit/com.teamclu.app/WebsiteData" \
  "${tmp3}/Library/WebKit/com.teamclu.app/WebsiteData/Default" \
  "${tmp3}/Library/WebKit/com.teamclu.app/WebsiteData/Default/fixture" \
  "${tmp3}/Library/WebKit/com.teamclu.app/WebsiteData/Default/fixture/LocalStorage"

HOME="$tmp3" "$RESET" -y \
  --short-name teamclu \
  --app-id com.teamclu.app \
  --keep-opencode \
  --keep-workspace \
  >/dev/null || true

chmod -R u+w "${tmp3}/Library/WebKit/com.teamclu.app" 2>/dev/null || true
remaining_setup="$(sqlite3 "$db3" "SELECT COUNT(*) FROM ItemTable WHERE key='teamclu-setup-ok';" 2>/dev/null || echo 0)"
remaining_session="$(sqlite3 "$db3" "SELECT COUNT(*) FROM ItemTable WHERE key='teamclu.session.v1';" 2>/dev/null || echo 0)"
assert_eq "no-write WebKit still clears setup-ok key" "0" "$remaining_setup"
assert_eq "no-write WebKit still clears session key" "0" "$remaining_session"

if [[ "$failures" -ne 0 ]]; then
  echo "${failures} failure(s)" >&2
  exit 1
fi
echo "All reset-local-state checks passed."
