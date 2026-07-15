-- GoTrue v2.188+ rejects refresh tokens whose length doesn't fit its bounds
-- (classic tokens are ~12-22 URL-safe chars on this project). The agent
-- branch of claim_team_invite was inserting 48-hex-char tokens; daemon
-- `init` then failed at the first refresh with
-- "crypto: refresh token length is not valid".
--
-- Fix: mint tokens as base64url(gen_random_bytes(16)) → 22 chars, which
-- matches the live format from GoTrue-issued sessions.

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
    -- 12 lowercase hex chars — matches GoTrue's live refresh-token format
    -- on this project. GoTrue rejects longer values with
    -- "crypto: refresh token length is not valid".
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

    -- last_active_at is intentionally null: agent is offline until its
    -- daemon publishes the first heartbeat via update_actor_last_active.
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

  update public.team_invites
     set consumed_at = now(), consumed_by_actor_id = v_actor, updated_at = now()
   where id = v_invite.id;

  return query
  select v_actor, v_invite.team_id, v_invite.kind::text,
         v_invite.display_name, v_rt;
end;
$$;
