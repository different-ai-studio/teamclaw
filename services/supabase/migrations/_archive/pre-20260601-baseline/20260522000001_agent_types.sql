-- Move backend capability off agents.agent_kind.
--
-- agents.agent_types        = JSON array of supported runtime backend types.
-- agents.default_agent_type = default backend type selected at runtime start.
-- agent_runtimes.backend_type remains the actual backend used by that spawn.

begin;

alter table public.agents
  add column if not exists agent_types jsonb not null default '[]'::jsonb;

alter table public.agents
  drop constraint if exists agents_default_agent_type_check;

update public.agents
   set default_agent_type = 'claude',
       updated_at = now()
 where default_agent_type = 'claude_code';

update public.agents
   set agent_types = (
         select coalesce(jsonb_agg(distinct t), '[]'::jsonb)
           from (
             select case
                      when default_agent_type = 'claude_code' then 'claude'
                      when default_agent_type in ('claude', 'opencode', 'codex') then default_agent_type
                    end as t
             union all
             select case
                      when agent_kind in ('claude', 'claude_code') then 'claude'
                      when agent_kind in ('opencode', 'codex') then agent_kind
                    end as t
           ) s
          where t is not null
       ),
       updated_at = now()
 where agent_types = '[]'::jsonb
   and (
     default_agent_type in ('claude', 'claude_code', 'opencode', 'codex')
     or agent_kind in ('claude', 'claude_code', 'opencode', 'codex')
   );

alter table public.agents
  add constraint agents_default_agent_type_check
  check (default_agent_type is null or default_agent_type in ('claude', 'opencode', 'codex', 'pi'));

alter table public.agents
  add constraint agents_agent_types_array_check
  check (jsonb_typeof(agent_types) = 'array');

comment on column public.agents.agent_types is
  'Supported runtime backend types for this agent as a JSON array, e.g. ["claude","opencode","codex"]. Empty means the daemon has not advertised support yet.';

comment on column public.agents.default_agent_type is
  'Preferred runtime backend type when no explicit agent type is requested. Canonical values match agent_runtimes.backend_type: claude, opencode, codex.';

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
  ag.status     as agent_status
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team';

grant select on public.actor_directory to authenticated;

drop function if exists public.update_current_actor_profile(uuid, text, text);

create function public.update_current_actor_profile(
  p_actor_id uuid,
  p_display_name text,
  p_avatar_url text default null
)
returns table (
  id uuid,
  team_id uuid,
  actor_type text,
  user_id uuid,
  invited_by_actor_id uuid,
  display_name text,
  avatar_url text,
  last_active_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  member_status text,
  team_role text,
  agent_types jsonb,
  default_agent_type text,
  agent_status text,
  default_workspace_id uuid
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_avatar_url text := nullif(btrim(coalesce(p_avatar_url, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  update public.actors a
     set display_name = v_display_name,
         avatar_url = v_avatar_url,
         updated_at = now()
   where a.id = p_actor_id
     and a.actor_type = 'member'
     and a.user_id = auth.uid();

  if not found then
    raise exception 'actor profile update is not allowed'
      using errcode = '42501';
  end if;

  return query
  select
    ad.id, ad.team_id, ad.actor_type, ad.user_id, ad.invited_by_actor_id,
    ad.display_name, ad.avatar_url, ad.last_active_at, ad.created_at, ad.updated_at,
    ad.member_status, ad.team_role, ad.agent_types, ad.default_agent_type,
    ad.agent_status, ad.default_workspace_id
  from public.actor_directory ad
  where ad.id = p_actor_id;
end;
$$;

revoke all on function public.update_current_actor_profile(uuid, text, text) from public;
grant execute on function public.update_current_actor_profile(uuid, text, text) to authenticated;

drop function if exists public.update_agent_defaults(uuid, uuid, text, text);
drop function if exists public.update_agent_defaults(uuid, uuid, text);

create function public.update_agent_defaults(
  p_agent_id             uuid,
  p_default_workspace_id uuid    default null,
  p_agent_kind           text    default null,
  p_default_agent_type   text    default null
)
returns table (
  agent_id             uuid,
  default_workspace_id uuid,
  agent_types          jsonb,
  default_agent_type   text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_team_id          uuid;
  v_caller           uuid := auth.uid();
  v_new_backend      text := nullif(btrim(coalesce(p_default_agent_type, '')), '');
begin
  if v_caller is null then
    raise exception 'update_agent_defaults requires authentication'
      using errcode = '42501';
  end if;

  select a.team_id into v_team_id
    from public.actors a
   where a.id = p_agent_id and a.actor_type = 'agent';

  if v_team_id is null then
    raise exception 'agent not found' using errcode = '23503';
  end if;

  if not app.is_team_member(v_team_id) then
    raise exception 'caller is not a member of the agent team'
      using errcode = '42501';
  end if;

  if p_default_workspace_id is not null then
    if not exists (
      select 1 from public.workspaces w
       where w.id = p_default_workspace_id and w.team_id = v_team_id
    ) then
      raise exception 'workspace is not in the agent team'
        using errcode = '23514';
    end if;
  end if;

  if v_new_backend in ('claude_code', 'claude-code') then
    v_new_backend := 'claude';
  end if;

  if v_new_backend is not null
     and v_new_backend not in ('opencode', 'codex', 'claude', 'pi') then
    raise exception 'invalid default_agent_type: must be opencode, codex, claude, or pi'
      using errcode = '23514';
  end if;

  if v_new_backend is not null and not exists (
    select 1 from public.agents ag, jsonb_array_elements_text(ag.agent_types) t(value)
     where ag.id = p_agent_id and t.value = v_new_backend
  ) then
    raise exception 'default_agent_type must be one of agent_types'
      using errcode = '23514';
  end if;

  update public.agents ag
     set default_workspace_id = coalesce(p_default_workspace_id, ag.default_workspace_id),
         default_agent_type   = coalesce(v_new_backend, ag.default_agent_type),
         updated_at           = now()
   where ag.id = p_agent_id;

  if not found then
    raise exception 'agent row missing' using errcode = '23503';
  end if;

  return query
  select ag.id, ag.default_workspace_id, ag.agent_types, ag.default_agent_type
    from public.agents ag
   where ag.id = p_agent_id;
end;
$$;

revoke all on function public.update_agent_defaults(uuid, uuid, text, text) from public;
grant execute on function public.update_agent_defaults(uuid, uuid, text, text) to authenticated;

create or replace function public.list_connected_agents(p_team_id uuid)
returns table (
  agent_id uuid,
  display_name text,
  agent_types jsonb,
  default_agent_type text,
  permission_level text,
  visibility text,
  is_owner boolean,
  device_id text,
  last_active_at timestamptz
)
language sql
security definer
set search_path = public, auth
as $$
  select
    ag.id as agent_id,
    a.display_name,
    ag.agent_types,
    ag.default_agent_type,
    coalesce(ama.permission_level, case when app.is_team_member(p_team_id) then 'view' end) as permission_level,
    ag.visibility,
    ag.owner_member_id = app.current_member_id() as is_owner,
    ag.device_id,
    a.last_active_at
  from public.agents ag
  join public.actors a on a.id = ag.id
  left join public.agent_member_access ama
    on ama.agent_id = ag.id
   and ama.member_id = app.current_member_id()
  where a.team_id = p_team_id
    and ag.status = 'active'
    and (
      ag.visibility = 'team'
      or ag.owner_member_id = app.current_member_id()
      or ama.member_id is not null
    )
$$;

revoke all on function public.list_connected_agents(uuid) from public;
grant execute on function public.list_connected_agents(uuid) to authenticated;

create or replace function public.claim_team_invite(
  p_token text
)
returns table (
  actor_id      uuid,
  team_id       uuid,
  actor_type    text,
  display_name  text,
  refresh_token text
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_invite     public.team_invites%rowtype;
  v_user_id    uuid;
  v_actor      uuid;
  v_email      text;
  v_session    uuid;
  v_rt         text := null;
  v_old_user   uuid;
  v_target_anon boolean;
begin
  select * into v_invite
    from public.team_invites where token = p_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = '23503';
  end if;
  if v_invite.consumed_at is not null then
    raise exception 'invite already consumed' using errcode = '23514';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite expired' using errcode = '23514';
  end if;

  if v_invite.kind = 'member' then
    if v_invite.target_actor_id is not null then
      select user_id into v_user_id
        from public.actors where id = v_invite.target_actor_id;
      if v_user_id is null then
        raise exception 'target member has no auth user'
          using errcode = '23503';
      end if;

      select coalesce(is_anonymous, false) into v_target_anon
        from auth.users where id = v_user_id;
      if not v_target_anon then
        raise exception 'target member is no longer anonymous'
          using errcode = '23514';
      end if;

      v_session := gen_random_uuid();
      v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

      insert into auth.sessions (id, user_id, aal, created_at, updated_at)
      values (v_session, v_user_id, 'aal1', now(), now());

      insert into auth.refresh_tokens
        (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
      values
        (v_rt, v_user_id::text, v_session, false,
         '00000000-0000-0000-0000-000000000000', now(), now());

      v_actor := v_invite.target_actor_id;
      update public.actors
         set last_active_at = now(), updated_at = now()
       where id = v_actor;
    else
      v_user_id := auth.uid();
      if v_user_id is null then
        raise exception 'member claim requires authentication' using errcode = '42501';
      end if;
      if exists (select 1 from public.actors act
                  where act.team_id = v_invite.team_id and act.user_id = v_user_id) then
        raise exception 'already a member of this team' using errcode = '23505';
      end if;

      insert into public.actors
        (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values
        (v_invite.team_id, 'member', v_user_id,
         v_invite.invited_by_actor_id, v_invite.display_name, now())
      returning id into v_actor;

      insert into public.members (id, status) values (v_actor, 'active');
      insert into public.team_members (team_id, member_id, role)
        values (v_invite.team_id, v_actor, v_invite.team_role);
    end if;
  else
    v_user_id := gen_random_uuid();
    v_email   := format('daemon.%s@amuxd.run', v_user_id);
    v_session := gen_random_uuid();
    v_rt      := substring(encode(extensions.gen_random_bytes(6), 'hex'), 1, 12);

    insert into auth.users (
      id, email, email_confirmed_at,
      encrypted_password, confirmation_token, recovery_token,
      email_change_token_new, email_change,
      raw_app_meta_data,
      aud, role, created_at, updated_at, instance_id
    )
    values (
      v_user_id, v_email, now(),
      '', '', '',
      '', '',
      '{}'::jsonb,
      'authenticated', 'authenticated',
      now(), now(), '00000000-0000-0000-0000-000000000000'
    );

    insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, v_user_id, 'aal1', now(), now());

    insert into auth.refresh_tokens
      (token, user_id, session_id, revoked, instance_id, created_at, updated_at)
    values
      (v_rt, v_user_id::text, v_session, false,
       '00000000-0000-0000-0000-000000000000', now(), now());

    if v_invite.target_actor_id is not null then
      select user_id into v_old_user from public.actors where id = v_invite.target_actor_id;
      update public.actors
         set user_id = v_user_id,
             invited_by_actor_id = v_invite.invited_by_actor_id,
             last_active_at = null,
             updated_at = now()
       where id = v_invite.target_actor_id;
      v_actor := v_invite.target_actor_id;

      update public.agents
         set owner_member_id = v_invite.invited_by_actor_id,
             visibility = 'team',
             updated_at = now()
       where id = v_actor;

      if v_old_user is not null then
        delete from auth.users where id = v_old_user;
      end if;
    else
      insert into public.actors
        (team_id, actor_type, user_id, invited_by_actor_id, display_name, last_active_at)
      values
        (v_invite.team_id, 'agent', v_user_id,
         v_invite.invited_by_actor_id, v_invite.display_name, null)
      returning id into v_actor;

      insert into public.agents (id, owner_member_id, visibility, status)
        values (v_actor, v_invite.invited_by_actor_id, 'team', 'active');
    end if;

    insert into public.agent_member_access
      (agent_id, member_id, permission_level, granted_by_member_id)
    values
      (v_actor, v_invite.invited_by_actor_id, 'admin',
       v_invite.invited_by_actor_id)
    on conflict (agent_id, member_id) do update
      set permission_level = 'admin',
          granted_by_member_id = excluded.granted_by_member_id,
          updated_at = now();
  end if;

  update public.team_invites
     set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now()
   where id = v_invite.id;

  return query
  select v_actor, v_invite.team_id, v_invite.kind::text,
         v_invite.display_name, v_rt;
end;
$$;

revoke all on function public.claim_team_invite(text) from public;
grant execute on function public.claim_team_invite(text) to anon, authenticated;

alter table public.agents drop column if exists agent_kind;

commit;
