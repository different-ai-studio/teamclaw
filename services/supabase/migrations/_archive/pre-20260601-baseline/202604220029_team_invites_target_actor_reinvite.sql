-- Re-invite support: `create_team_invite` can now bind a fresh invite to an
-- existing agent actor via `p_target_actor_id`. `claim_team_invite`
-- rotates that actor's Supabase credentials (new auth.users / refresh
-- token) in place instead of minting a second actor row.

alter table public.team_invites
  add column if not exists target_actor_id uuid
    references public.actors(id) on delete cascade;

create or replace function public.create_team_invite(
  p_team_id uuid,
  p_kind text,
  p_display_name text,
  p_team_role text default null,
  p_agent_kind text default null,
  p_ttl_seconds int default 604800,
  p_target_actor_id uuid default null
)
returns table (
  token text,
  expires_at timestamptz,
  deeplink text
)
language plpgsql security definer set search_path = public, auth, app
as $$
declare
  v_caller uuid := app.current_actor_id_for_team(p_team_id);
  v_token  text := translate(
                     encode(extensions.gen_random_bytes(24), 'base64'),
                     '+/=', '-_0'
                   );
  v_expires timestamptz := now() + make_interval(secs => greatest(60, p_ttl_seconds));
  v_kind    text;
  v_role    text;
  v_target  public.actors%rowtype;
begin
  if v_caller is null then
    raise exception 'create_team_invite requires team membership'
      using errcode = '42501';
  end if;

  v_kind := lower(coalesce(p_kind, ''));
  if v_kind not in ('member','agent') then
    raise exception 'p_kind must be member or agent' using errcode = '22023';
  end if;

  if v_kind = 'member' then
    if p_team_role is null or btrim(p_team_role) = '' then
      raise exception 'member invites require p_team_role' using errcode = '22023';
    end if;
    v_role := lower(p_team_role);
    if v_role not in ('owner','admin','member') then
      raise exception 'team_role must be owner/admin/member' using errcode = '22023';
    end if;
    if p_target_actor_id is not null then
      raise exception 'p_target_actor_id is only valid for agent invites'
        using errcode = '22023';
    end if;
  else
    if p_agent_kind is null or btrim(p_agent_kind) = '' then
      raise exception 'agent invites require p_agent_kind' using errcode = '22023';
    end if;
    if p_target_actor_id is not null then
      select * into v_target from public.actors where id = p_target_actor_id;
      if not found then
        raise exception 'target actor not found' using errcode = '23503';
      end if;
      if v_target.team_id <> p_team_id then
        raise exception 'target actor belongs to a different team'
          using errcode = '23514';
      end if;
      if v_target.actor_type <> 'agent' then
        raise exception 'target actor must be an agent' using errcode = '22023';
      end if;
    end if;
  end if;

  insert into public.team_invites (
    team_id, kind, display_name, team_role, agent_kind,
    invited_by_actor_id, token, expires_at, target_actor_id
  )
  values (
    p_team_id, v_kind, btrim(p_display_name), v_role, p_agent_kind,
    v_caller, v_token, v_expires, p_target_actor_id
  );

  return query
  select v_token,
         v_expires,
         format('amux://invite?token=%s', v_token);
end;
$$;

revoke all on function public.create_team_invite(uuid, text, text, text, text, int, uuid) from public;
grant execute on function public.create_team_invite(uuid, text, text, text, text, int, uuid) to authenticated;
drop function if exists public.create_team_invite(uuid, text, text, text, text, int);

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
  v_invite   public.team_invites%rowtype;
  v_user_id  uuid;
  v_actor    uuid;
  v_email    text;
  v_session  uuid;
  v_rt       text := null;
  v_old_user uuid;
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

      insert into public.agents (id, agent_kind, status)
        values (v_actor, v_invite.agent_kind, 'active');

      insert into public.agent_member_access
        (agent_id, member_id, permission_level, granted_by_member_id)
      values
        (v_actor, v_invite.invited_by_actor_id, 'admin',
         v_invite.invited_by_actor_id);
    end if;
  end if;

  update public.team_invites
     set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now()
   where id = v_invite.id;

  return query
  select v_actor, v_invite.team_id, v_invite.kind::text,
         v_invite.display_name, v_rt;
end;
$$;
