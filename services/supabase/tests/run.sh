#!/usr/bin/env bash
#
# Run the pgTAP suite against a Postgres that already has the migrations applied.
#
#   ./run.sh                # every test that is not quarantined
#   ./run.sh 002_rls.sql    # just these
#   ALL=1 ./run.sh          # include quarantined ones (expected to fail)
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
# These predate two schema migrations (public -> amux, and the actor/member
# split) and assert against tables and columns that no longer exist. They are
# NOT run by default: a suite that is always red gets ignored, and an ignored
# suite is how this one rotted in the first place.
#
# QUARANTINE.md explains what each one needs. Fixing one = delete its line here
# and make it pass.
QUARANTINE=$(cat <<'EOF'
001_schema_shape.sql
002_rls.sql
003_team_invites.sql
004_member_reinvite.sql
005_agent_role_rls.sql
006_access_token_hook.sql
006_gateway_external_actor.sql
007_team_workspace_config.sql
008_actor_telemetry.sql
009_agent_visibility.sql
011_gateway_session_rpc.sql
012_gateway_message_external_id_upsert.sql
013_gateway_agent_admin_owner_rpc.sql
014_gateway_external_message_rls.sql
015_rbac_shortcuts.sql
016_push_notifications.sql
017_idea_create_order.sql
018_idea_activity_attachment_urls.sql
019_idea_attachment_storage_rls.sql
020_oss_sync_schema.sql
021_agent_reinvite_owner_check.sql
025_agent_delete_authz.sql
027_org_default_team_selection.sql
028_phone_linked_org_picker.sql
029_empty_org_public_bootstrap.sql
claim_team_invite_agent_org.test.sql
team_default_agent.test.sql
team_share_mode.test.sql
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
  out=$($PSQL -v ON_ERROR_STOP=0 -q < "$f" 2>&1)
  # Two styles live in this directory: pgTAP files emit "ok"/"not ok", while the
  # newer ones assert with `raise exception` and print nothing when they pass.
  # A failure in either shows up as "not ok" or as an ERROR, so both count.
  if printf '%s' "$out" | grep -q '^not ok' || printf '%s' "$out" | grep -qE '^(psql:)?.*ERROR:'; then
    fail=$((fail + 1))
    printf 'FAIL  %s\n' "$f"
    printf '%s\n' "$out" | grep -E '^not ok|ERROR:' | head -5 | sed 's/^/      /'
  else
    printf 'ok    %s\n' "$f"
  fi
done

printf '\n%s run, %s failed, %s quarantined\n' "$ran" "$fail" "$skipped"
[ "$fail" -eq 0 ]
