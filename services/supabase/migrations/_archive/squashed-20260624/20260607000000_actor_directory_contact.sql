-- Surface a human member's email + phone in actor_directory so clients can
-- show contact details on the actor profile (desktop + iOS).
--
-- email/phone live in auth.users, which authenticated callers cannot read
-- directly. actor_directory is `security_invoker = true`, so a plain
-- `join auth.users` would be evaluated with the caller's (insufficient)
-- privileges and return nothing.
--
-- Instead we go through a SECURITY DEFINER helper that reads auth.users but
-- only returns contact for a target user the CALLER shares a team with — so a
-- direct call (`select app.actor_user_contact('<any uuid>')`) cannot be used to
-- harvest arbitrary users' contact info. Combined with the view's existing
-- per-caller row visibility (actors/agents RLS), the net effect is exactly the
-- product decision: every team member can see their teammates' email + phone.
--
-- Contact is only populated for non-agent actors; agents never expose it.

create or replace function app.actor_user_contact(p_user_id uuid)
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
      from public.actors them
      join public.actors me on me.team_id = them.team_id
      where them.user_id = p_user_id
        and me.user_id = auth.uid()
    )
$func$;

comment on function app.actor_user_contact(uuid) is
  'Returns (email, phone) from auth.users for p_user_id, but only when the caller (auth.uid()) shares a team with that user. SECURITY DEFINER so it can read auth.users; the team-sharing guard prevents arbitrary contact harvesting via direct calls. Used by the actor_directory view.';

revoke all on function app.actor_user_contact(uuid) from public;
grant execute on function app.actor_user_contact(uuid) to authenticated;

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
  ag.status     as agent_status,
  c.email       as user_email,
  c.phone       as user_phone
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
left join lateral app.actor_user_contact(a.user_id) c
  on a.actor_type <> 'agent' and a.user_id is not null
where a.actor_type <> 'agent'
   or ag.visibility = 'team'
   or ag.owner_member_id = app.current_actor_id_for_team(a.team_id);

grant select on public.actor_directory to authenticated;
