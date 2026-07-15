-- ============================================================================
-- Fix: actor_directory contact columns (user_email / user_phone) never landed
-- in the `amux` schema, so clients querying `actor_directory` for those columns
-- hit `column actor_directory.user_email does not exist`.
--
-- Two reasons this slipped through:
--   1. 20260607000000_actor_directory_contact created the helper + view columns
--      against the `public` schema, but S2 (20260608010000) later moved the base
--      tables to `amux` WITHOUT rewriting the SECURITY DEFINER function body
--      (function bodies are text, resolved via search_path — they don't follow
--      a table's schema move the way a view's OID dependencies do). So on a
--      fresh replay the function would reference a now-missing `public.actors`.
--   2. Production applied S2 + the view move but skipped 20260607000000 entirely,
--      so neither the helper nor the columns ever existed there.
--
-- This migration is idempotent and re-creates both objects against `amux`, the
-- canonical post-S2 location. Safe to run on any environment already past S2.
-- See 20260607000000_actor_directory_contact.sql for the security rationale.
-- ============================================================================

-- SECURITY DEFINER helper: returns (email, phone) from auth.users, but only when
-- the caller shares a team with the target user — prevents contact harvesting via
-- direct calls. Now reads amux.actors instead of public.actors.
create or replace function amux.actor_user_contact(p_user_id uuid)
returns table (email text, phone text)
language sql
stable
security definer
set search_path = ''
as $func$
  select u.email::text, nullif(u.phone, '')::text
  from auth.users u
  where u.id = p_user_id
    and exists (
      -- caller shares at least one team with the target user
      select 1
      from amux.actors them
      join amux.actors me on me.team_id = them.team_id
      where them.user_id = p_user_id
        and me.user_id = auth.uid()
    )
$func$;

comment on function amux.actor_user_contact(uuid) is
  'Returns (email, phone) from auth.users for p_user_id, but only when the caller (auth.uid()) shares a team with that user. SECURITY DEFINER so it can read auth.users; the team-sharing guard prevents arbitrary contact harvesting via direct calls. Used by the actor_directory view.';

revoke all on function amux.actor_user_contact(uuid) from public;
grant execute on function amux.actor_user_contact(uuid) to authenticated;

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
  c.email       as user_email,
  c.phone       as user_phone
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
