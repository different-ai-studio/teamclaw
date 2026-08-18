-- ============================================================================
-- actor_directory: expose `source` / `source_id` for EXTERNAL actors.
--
-- External actors are gateway contacts (`actor_type = 'external'`, created by
-- amux.upsert_external_actor from wecom / wechat / feishu / discord / kook /
-- seatalk / email). The channel they came in through is the single most
-- identifying fact about such a row — a WeCom external contact whose nickname
-- never resolved is listed under its raw `wo…` userid, and without the source
-- there is nothing on screen that says where it came from.
--
-- The view has never projected these two columns, so no client could show them.
-- Both are NULL for members and agents (an actors CHECK constraint enforces
-- that only external rows carry them), which is why they can be added without
-- touching any existing consumer.
--
-- Rebased on 20260729100000_agent_delete_authz.sql (the previous definition,
-- which added owner_member_id). Everything else — security_invoker, the joins,
-- the agent-visibility WHERE — is carried over verbatim.
-- ============================================================================

drop view if exists amux.actor_directory;

create view amux.actor_directory
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
  ag.status     as agent_status,
  ag.owner_member_id,
  c.email       as user_email,
  c.phone       as user_phone,
  a.source,
  a.source_id
from amux.actors a
left join amux.members      m  on m.id         = a.id
left join amux.team_members tm on tm.member_id = a.id
left join amux.agents       ag on ag.id        = a.id
left join lateral amux.actor_user_contact(a.user_id) c
  on a.actor_type <> 'agent' and a.user_id is not null
where a.actor_type <> 'agent'
   or ag.visibility = 'team'
   or ag.owner_member_id = amux.current_actor_id_for_team(a.team_id);

grant select on amux.actor_directory to authenticated;
