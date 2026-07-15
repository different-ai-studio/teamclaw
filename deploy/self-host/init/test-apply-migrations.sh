#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/migrations"
printf 'select 1;\n' > "$TMP/migrations/20260101000000_a.sql"
printf 'select 2;\n' > "$TMP/migrations/20260102000000_b.sql"
mkdir -p "$TMP/migrations/_archive"; printf 'BAD;\n' > "$TMP/migrations/_archive/x.sql"
printf 'select 3;\n' > "$TMP/seed.sql"
# stub psql: record each invocation's -f / -c into a log, fake "already applied" empty set
cat > "$TMP/psql" <<'EOF'
#!/usr/bin/env bash
args="$*"
echo "psql $args" >> "$APPLY_LOG"
# emulate the "is applied?" query returning nothing (not applied)
if echo "$args" | grep -q "select 1 from _selfhost.schema_migrations"; then exit 0; fi
exit 0
EOF
chmod +x "$TMP/psql"
export PATH="$TMP:$PATH" APPLY_LOG="$TMP/log"
APPLY_SEED=true MIGRATIONS_DIR="$TMP/migrations" SEED_FILE="$TMP/seed.sql" ./apply-migrations.sh
# archive file must NOT be applied; a + b + seed must be, in order
grep -q "_archive" "$TMP/log" && { echo "FAIL: applied _archive"; exit 1; }
grep -q "20260101000000_a.sql" "$TMP/log" || { echo "FAIL: a not applied"; exit 1; }
ord_a=$(grep -n "20260101000000_a.sql" "$TMP/log" | head -1 | cut -d: -f1)
ord_b=$(grep -n "20260102000000_b.sql" "$TMP/log" | head -1 | cut -d: -f1)
[ "$ord_a" -lt "$ord_b" ] || { echo "FAIL: order wrong"; exit 1; }
grep -q "seed.sql" "$TMP/log" || { echo "FAIL: seed not applied"; exit 1; }
echo "PASS"
