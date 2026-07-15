-- Agent personal/team visibility and agent-owned permissions.

alter table public.agents
  add column if not exists visibility text;

update public.agents
   set visibility = 'personal'
 where visibility is null;

alter table public.agents
  alter column visibility set default 'personal',
  alter column visibility set not null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'agents_visibility_check'
       and conrelid = 'public.agents'::regclass
  ) then
    alter table public.agents
      add constraint agents_visibility_check
      check (visibility in ('personal', 'team'));
  end if;
end;
$$;

alter table public.agents
  add column if not exists owner_member_id uuid;

update public.agents ag
   set owner_member_id = coalesce(
     (
       select ama.member_id
         from public.agent_member_access ama
        where ama.agent_id = ag.id
          and ama.permission_level = 'admin'
        order by ama.created_at asc
        limit 1
     ),
     (
       select act.invited_by_actor_id
         from public.actors act
         join public.members m on m.id = act.invited_by_actor_id
        where act.id = ag.id
        limit 1
     ),
     (
       select tm.member_id
         from public.actors act
         join public.team_members tm on tm.team_id = act.team_id
        where act.id = ag.id
        order by case tm.role when 'owner' then 0 when 'admin' then 1 else 2 end,
                 tm.joined_at asc
        limit 1
     )
   )
 where ag.owner_member_id is null;

do $$
begin
  if exists (select 1 from public.agents where owner_member_id is null) then
    raise exception 'agents.owner_member_id backfill failed';
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'agents_owner_member_id_fkey'
       and conrelid = 'public.agents'::regclass
  ) then
    alter table public.agents
      add constraint agents_owner_member_id_fkey
      foreign key (owner_member_id)
      references public.members(id)
      on delete restrict
      not valid;
  end if;
end;
$$;

alter table public.agents
  validate constraint agents_owner_member_id_fkey;

alter table public.agents
  alter column owner_member_id set not null;

insert into public.agent_member_access (
  agent_id,
  member_id,
  permission_level,
  granted_by_member_id
)
select
  ag.id,
  ag.owner_member_id,
  'admin',
  ag.owner_member_id
from public.agents ag
on conflict (agent_id, member_id) do update
  set permission_level = 'admin',
      updated_at = now();

drop view if exists public.actor_directory;

create view public.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_kind as agent_kind,
  ag.status     as agent_status
from public.actors a
left join public.members      m  on m.id         = a.id
left join public.team_members tm on tm.member_id = a.id
left join public.agents       ag on ag.id        = a.id
where a.actor_type <> 'agent'
   or ag.visibility = 'team';

grant select on public.actor_directory to authenticated;

drop policy if exists agents_select_if_team_member on public.agents;
create policy agents_select_if_visible on public.agents
for select to authenticated using (
  exists (
    select 1
      from public.actors a
     where a.id = agents.id
       and app.is_team_member(a.team_id)
       and (
         agents.visibility = 'team'
         or agents.owner_member_id = app.current_member_id()
       )
  )
);

drop policy if exists agent_member_access_select_if_team_member on public.agent_member_access;
create policy agent_member_access_select_if_agent_owner_or_self on public.agent_member_access
for select to authenticated using (
  member_id = app.current_member_id()
  or exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_member_id()
  )
);

drop policy if exists agent_member_access_manage_if_admin on public.agent_member_access;
create policy agent_member_access_manage_if_agent_owner on public.agent_member_access
for all to authenticated using (
  exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_member_id()
  )
)
with check (
  exists (
    select 1
      from public.agents ag
     where ag.id = agent_member_access.agent_id
       and ag.owner_member_id = app.current_member_id()
  )
);

create or replace function app.can_prompt_agent(target_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.agent_member_access ama
      join public.agents ag on ag.id = ama.agent_id
      join public.actors act on act.id = ag.id
     where ama.agent_id = target_agent_id
       and ama.member_id = app.current_member_id()
       and ama.permission_level in ('prompt', 'admin')
       and app.is_team_member(act.team_id)
       and (
         ag.visibility = 'team'
         or ag.owner_member_id = app.current_member_id()
       )
  )
$$;

create or replace function public.check_agent_permission(
  p_agent_id uuid,
  p_actor_id uuid
) returns text
language sql security definer set search_path = public
as $$
  select ama.permission_level
    from public.agent_member_access ama
    join public.agents ag on ag.id = ama.agent_id
   where ama.agent_id = p_agent_id
     and ama.member_id = p_actor_id
     and (
       ag.visibility = 'team'
       or ag.owner_member_id = p_actor_id
     )
   limit 1;
$$;

create or replace function public.share_agent_to_team(
  p_agent_id uuid
) returns void
language plpgsql security definer set search_path = public, auth, app
as $$
begin
  if not exists (
    select 1
      from public.agents ag
     where ag.id = p_agent_id
       and ag.owner_member_id = app.current_member_id()
  ) then
    raise exception 'only agent owner can share agent to team'
      using errcode = '42501';
  end if;

  update public.agents
     set visibility = 'team',
         updated_at = now()
   where id = p_agent_id;
end;
$$;

create or replace function public.make_agent_personal(
  p_agent_id uuid
) returns void
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_owner uuid;
begin
  select owner_member_id into v_owner
    from public.agents
   where id = p_agent_id;

  if v_owner is null or v_owner <> app.current_member_id() then
    raise exception 'only agent owner can make agent personal'
      using errcode = '42501';
  end if;

  update public.agents
     set visibility = 'personal',
         updated_at = now()
   where id = p_agent_id;

  delete from public.agent_member_access
   where agent_id = p_agent_id
     and member_id <> v_owner;

  insert into public.agent_member_access (
    agent_id,
    member_id,
    permission_level,
    granted_by_member_id
  )
  values (p_agent_id, v_owner, 'admin', v_owner)
  on conflict (agent_id, member_id) do update
    set permission_level = 'admin',
        granted_by_member_id = excluded.granted_by_member_id,
        updated_at = now();
end;
$$;

revoke all on function public.share_agent_to_team(uuid) from public;
revoke all on function public.make_agent_personal(uuid) from public;
grant execute on function public.share_agent_to_team(uuid) to authenticated;
grant execute on function public.make_agent_personal(uuid) to authenticated;

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

      insert into public.agents (id, owner_member_id, visibility, agent_kind, status)
        values (v_actor, v_invite.invited_by_actor_id, 'team', v_invite.agent_kind, 'active');
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
