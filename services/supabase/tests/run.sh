#!/usr/bin/env bash
#
# Run the pgTAP suite against a Postgres that already has the migrations applied.
#
#   ./run.sh                # every test in this directory
#   ./run.sh 002_rls.sql    # just these
#   ALL=1 ./run.sh          # include quarantined ones (the list is empty today)
#
# Connection comes from the standard PG* variables (PGHOST, PGPORT, PGUSER,
# PGPASSWORD, PGDATABASE), so it works the same in CI and against a local stack.
# Override $PSQL to reach a container instead, e.g.
#   PSQL="docker exec -i supabase-db psql -U postgres -d postgres" ./run.sh
#
# Each test file opens its own transaction and rolls back, so they are isolated
# and leave nothing behind.
set -uo pipefail
cd "$(dirname "$0")"

PSQL=${PSQL:-psql}

# ── Quarantine ──────────────────────────────────────────────────────────────
#
# Empty, and worth keeping that way: a suite that is always red gets ignored,
# and an ignored suite is how this directory rotted the first time.
#
# The mechanism stays because it is the honest way to land a test that cannot
# pass yet -- park the filename here and write down in QUARANTINE.md what it
# needs. Skipping is visible in the summary line; a silently failing test is
# not.
QUARANTINE=$(cat <<'EOF'
EOF
)

is_quarantined() {
  [ -n "${ALL:-}" ] && return 1
  printf '%s\n' "$QUARANTINE" | grep -qx "$1"
}

if [ "$#" -gt 0 ]; then
  FILES="$*"
else
  FILES=$(ls -1 *.sql | grep -v '^ci-bootstrap\.sql$')
fi

fail=0
ran=0
skipped=0

for f in $FILES; do
  if is_quarantined "$f"; then
    skipped=$((skipped + 1))
    continue
  fi
  ran=$((ran + 1))
  # stdin rather than -f: keeps $PSQL overridable with a `docker exec -i` form,
  # where the file would not exist inside the container.
  #
  # -tA is not cosmetic. psql's default aligned output wraps every result in a
  # bordered table, which indents each TAP line by one space -- and a leading
  # space is enough for `grep '^not ok'` to miss it. This directory ran green
  # for a while with 68 failing assertions hidden that way. Tuples-only +
  # unaligned puts "not ok" back at column 0; the grep below stays tolerant of
  # leading whitespace anyway, so neither guard alone can hide a failure.
  out=$($PSQL -v ON_ERROR_STOP=0 -qtA < "$f" 2>&1)
  rc=$?
  # Two styles live in this directory: pgTAP files emit "ok"/"not ok", while the
  # newer ones assert with `raise exception` and print nothing when they pass.
  # A failure in either shows up as "not ok" or as an ERROR, so both count.
  #
  # $rc matters on its own: ON_ERROR_STOP=0 makes psql exit 0 through SQL errors,
  # but it still exits 2 when the connection dies. A backend crash prints
  # "server closed the connection unexpectedly" and no ERROR: line, so without
  # this check a segfault mid-file reads as a pass.
  #
  # The "Looks like you planned N but ran M" line matters too: a file whose
  # plan() count drifts past its assertions is not proving what it claims, and
  # every assertion can still say "ok" while the file as a whole is wrong.
  if [ "$rc" -ne 0 ] \
     || printf '%s' "$out" | grep -qE '^[[:space:]]*not ok' \
     || printf '%s' "$out" | grep -qE '^(psql:)?.*ERROR:' \
     || printf '%s' "$out" | grep -qE '^[[:space:]]*# Looks like you (planned|failed)'; then
    fail=$((fail + 1))
    printf 'FAIL  %s\n' "$f"
    printf '%s\n' "$out" | grep -E '^[[:space:]]*not ok|ERROR:|^[[:space:]]*# Looks like|server closed the connection' \
      | head -5 | sed 's/^/      /'
    [ "$rc" -ne 0 ] && printf '      psql exited %s\n' "$rc"
  else
    printf 'ok    %s\n' "$f"
  fi
done

printf '\n%s run, %s failed, %s quarantined\n' "$ran" "$fail" "$skipped"
[ "$fail" -eq 0 ]
