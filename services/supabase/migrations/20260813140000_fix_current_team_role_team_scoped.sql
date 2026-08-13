-- Fix amux.current_team_role for multi-team users.
--
-- current_team_role previously resolved the caller via amux.current_member_id(),
-- which returns the oldest active member actor across ALL teams (no team filter).
-- For a user who is owner of team A (older actor) and admin of team B, calls
-- scoped to team B (set_team_default_agent, remove_team_actor, and every RLS
-- policy behind is_team_admin_or_owner) looked up team_members with the team-A
-- actor id → no row → role null → false 403.
--
-- Same class of bug as 20260731000000_fix_workspaces_insert_rls.sql.
-- Fix: resolve via current_actor_id_for_team(target_team_id).

create or replace function amux.current_team_role(target_team_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public', 'auth'
as $$
  select tm.role
  from amux.team_members tm
  where tm.team_id = target_team_id
    and tm.member_id = amux.current_actor_id_for_team(target_team_id)
  limit 1
$$;

revoke all on function amux.current_team_role(uuid) from public;
grant execute on function amux.current_team_role(uuid) to authenticated;
