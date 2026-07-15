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
  v_target_anon boolean;
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
      select * into v_target from public.actors where id = p_target_actor_id;
      if not found then
        raise exception 'target actor not found' using errcode = '23503';
      end if;
      if v_target.team_id <> p_team_id then
        raise exception 'target actor belongs to a different team'
          using errcode = '23514';
      end if;
      if v_target.actor_type <> 'member' then
        raise exception 'target actor must be a member' using errcode = '22023';
      end if;
      if v_target.user_id is null then
        raise exception 'target member has no auth user'
          using errcode = '23503';
      end if;
      select coalesce(is_anonymous, false) into v_target_anon
        from auth.users where id = v_target.user_id;
      if not v_target_anon then
        raise exception 'cannot re-invite member with bound auth identity'
          using errcode = '22023';
      end if;
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
      if not exists (
        select 1 from public.agents
        where id = p_target_actor_id
          and owner_member_id = v_caller
      ) then
        raise exception 'only the agent owner can re-invite this agent'
          using errcode = '42501';
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
