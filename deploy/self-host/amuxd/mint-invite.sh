#!/usr/bin/env bash
# Operator helper: mint a *daemon* (agent) team invite for the self-host stack.
#
# Unlike the app's amux.create_team_invite RPC (which requires the caller to be
# a team member), this does a SERVICE-ROLE direct INSERT into amux.team_invites,
# so an operator can mint one without an inviting member. The claim RPC
# (amux.claim_team_invite) then creates the daemon's agent actor on first start.
#
# Usage:
#   ./mint-invite.sh [TEAM_ID]
#     TEAM_ID  optional; env TEAM_ID also works. If absent, the first team in
#              amux.teams is used.
#
# Prints the invite token and the line to add to deploy/self-host/.env.
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
PGPW="${POSTGRES_PASSWORD:-localpw}"
TEAM_ID="${1:-${TEAM_ID:-}}"
DISPLAY_NAME="${DISPLAY_NAME:-Self-host Daemon}"
TTL_DAYS="${TTL_DAYS:-7}"

psql() { docker exec -i -e PGPASSWORD="$PGPW" "$DB_CONTAINER" psql -U postgres -d postgres -tA "$@"; }

if [ -z "$TEAM_ID" ]; then
  TEAM_ID="$(psql -c "select id from amux.teams order by created_at asc limit 1;")"
  if [ -z "$TEAM_ID" ]; then
    echo "mint-invite: no teams found in amux.teams. Create a team first." >&2
    exit 1
  fi
  echo "mint-invite: no TEAM_ID given; using first team: $TEAM_ID" >&2
fi

# The claim sets the daemon agent's owner_member_id from the invite's
# invited_by_actor_id (NOT NULL on amux.agents), so the invite needs a real
# member of the team as inviter. Use the team's earliest member.
INVITER="${INVITER_ACTOR_ID:-$(psql -c "select tm.member_id from amux.team_members tm join amux.actors a on a.id=tm.member_id where tm.team_id='$TEAM_ID' order by a.created_at asc limit 1;")}"
if [ -z "$INVITER" ]; then
  echo "mint-invite: team $TEAM_ID has no member actor to own the daemon agent." >&2
  echo "mint-invite: a human member must exist in the team first." >&2
  exit 1
fi

# URL-safe random token (base64url, no padding).
TOKEN="$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"

psql -c "insert into amux.team_invites
  (team_id, token, kind, agent_kind, display_name, invited_by_actor_id, expires_at)
  values ('$TEAM_ID', '$TOKEN', 'agent', 'daemon', '$DISPLAY_NAME', '$INVITER', now() + interval '$TTL_DAYS days');" >/dev/null

echo "mint-invite: minted daemon invite for team $TEAM_ID (expires in ${TTL_DAYS}d)" >&2
echo >&2
echo "AMUXD_JOIN_TOKEN=$TOKEN"
echo >&2
echo "Add the line above to deploy/self-host/.env, then:" >&2
echo "  docker compose --profile daemon up -d --build amuxd" >&2
