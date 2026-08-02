-- Fix workspaces INSERT RLS for multi-team users.
--
-- workspaces_insert_if_team_member previously required
--   created_by_member_id = amux.current_member_id()
-- but current_member_id() returns the caller's *oldest* active member actor
-- across ALL teams (no team filter). A user in team A (older) and team B who
-- creates a workspace in team B with their team-B member id fails RLS even
-- though they are a legitimate member — the classic current_member_id
-- multi-team bug already documented in FC authz helpers.
--
-- Daemon agents use a separate auth user, so workspaces_agent_write
-- (is_current_agent) does not cover the human "add workspace" path either.
--
-- Fix: compare against the team-scoped helper, matching sessions/apps insert
-- policies (created_by_* = current_actor_id_for_team(team_id)).

drop policy if exists workspaces_insert_if_team_member on amux.workspaces;

create policy workspaces_insert_if_team_member on amux.workspaces
  for insert to authenticated
  with check (
    amux.is_team_member(team_id)
    and (
      created_by_member_id is null
      or created_by_member_id = amux.current_actor_id_for_team(team_id)
    )
  );
