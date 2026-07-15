create or replace function public.create_team_invite(
  p_team_id       uuid,
  p_kind          text,
  p_display_name  text,
  p_team_role     text default null,
  p_agent_kind    text default null,
  p_ttl_seconds   int  default 604800
)
returns table (token text, expires_at timestamptz, deeplink text)
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_actor_id  uuid := app.current_actor_id_for_team(p_team_id);
  v_is_member boolean;
  v_token     text;
  v_expires   timestamptz;
  v_ttl       int;
  v_broker    text := 'mqtts://ai.ucar.cc:8883';
  v_username  text := 'teamclaw';
  v_password  text := 'teamclaw2026';
begin
  if v_actor_id is null then
    raise exception 'create_team_invite requires team membership'
      using errcode = '42501';
  end if;

  select exists (select 1 from public.members where id = v_actor_id)
    into v_is_member;
  if not v_is_member then
    raise exception 'only member actors may create invites'
      using errcode = '42501';
  end if;

  if p_kind = 'member' then
    if coalesce(p_team_role, '') not in ('member','admin') then
      raise exception 'team_role must be member or admin' using errcode = '22023';
    end if;
    if p_agent_kind is not null then
      raise exception 'agent_kind not allowed for member invite' using errcode = '22023';
    end if;
  elsif p_kind = 'agent' then
    if p_agent_kind is null or btrim(p_agent_kind) = '' then
      raise exception 'agent_kind is required for agent invite' using errcode = '22023';
    end if;
    if p_team_role is not null then
      raise exception 'team_role not allowed for agent invite' using errcode = '22023';
    end if;
  else
    raise exception 'kind must be member or agent' using errcode = '22023';
  end if;

  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'display_name is required' using errcode = '22023';
  end if;

  v_ttl := greatest(60, least(coalesce(p_ttl_seconds, 604800), 60 * 60 * 24 * 30));
  v_expires := now() + make_interval(secs => v_ttl);
  v_token := replace(replace(replace(
    encode(extensions.gen_random_bytes(24), 'base64'), '+','-'), '/','_'), '=','');

  insert into public.team_invites
    (team_id, token, kind, team_role, agent_kind,
     display_name, invited_by_actor_id, expires_at)
  values
    (p_team_id, v_token, p_kind, p_team_role, p_agent_kind,
     btrim(p_display_name), v_actor_id, v_expires);

  return query
  select
    v_token,
    v_expires,
    format(
      'amux://invite?token=%s&broker=%s&username=%s&password=%s',
      v_token,
      v_broker,
      v_username,
      v_password
    );
end;
$$;
