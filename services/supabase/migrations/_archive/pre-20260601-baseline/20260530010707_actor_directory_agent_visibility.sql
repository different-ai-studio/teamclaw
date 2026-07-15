-- Surface agent visibility (team | personal) in the actor_directory read
-- surface, and stop hiding the caller's OWN personal agents from it.
--
-- Background: the previous actor_directory definition (20260522000001) only
-- exposed agents whose visibility = 'team', so personal agents never appeared
-- in the team members list. The UI now wants to render each agent's
-- Team/Personal kind in the actors list, which requires (a) the visibility
-- column to be readable and (b) the caller's own personal agents to be
-- included alongside team agents.
--
-- The owner predicate mirrors the canonical team-scoped pattern used by
-- list_connected_agents / agent RLS (20260529100001):
--     ag.visibility = 'team'
--     OR ag.owner_member_id = app.current_actor_id_for_team(team_id)
-- Note: app.current_actor_id_for_team is team-scoped — NOT app.current_member_id(),
-- which returns the oldest actor across all teams and breaks multi-team owner checks.
--
-- This view is security_invoker = true, so the owner predicate is evaluated per
-- caller; combined with the existing agents RLS (team OR owner) it never leaks
-- another user's personal agent.

drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.avatar_url, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_types,
  ag.default_agent_type,
  ag.default_workspace_id,
  ag.visibility as agent_visibility,
  ag.status     as agent_status
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team'
   or ag.owner_member_id = app.current_actor_id_for_team(a.team_id);

grant select on public.actor_directory to authenticated;
