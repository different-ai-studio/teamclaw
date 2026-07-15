-- Pivot claim_daemon_invite from password-grant to direct refresh-token mint.
--
-- Prior design (password grant) failed on hosted Supabase: GoTrue rejects
-- DB-provisioned users at /auth/v1/token?grant_type=password with
-- invalid_credentials even when email + bcrypt hash + identity row are all
-- set correctly. Root cause appears to be a server-side anti-abuse check we
-- cannot satisfy from the DB.
--
-- New design: insert auth.sessions + auth.refresh_tokens directly and return
-- the token string. The daemon persists it and uses grant_type=refresh_token
-- immediately (which DOES work for DB-provisioned users because it's just a
-- token lookup — no password check).

drop function if exists public.claim_daemon_invite(uuid);

create or replace function public.claim_daemon_invite(
  p_invite_token uuid
)
returns table (
  agent_id uuid,
  team_id uuid,
  refresh_token text
)
language plpgsql
security definer
set search_path = public, auth, app
as $$
declare
  v_invite record;
  v_uid uuid;
  v_session uuid;
  v_email text;
  v_token text;
begin
  select * into v_invite from public.daemon_invites
    where invite_token = p_invite_token
    for update;

  if not found then
    raise exception 'invite not found' using errcode = 'P0001';
  end if;
  if v_invite.claimed_at is not null then
    raise exception 'invite already claimed' using errcode = 'P0001';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite expired' using errcode = 'P0001';
  end if;

  v_email := format('daemon.%s@amuxd.run', v_invite.agent_id);
  v_uid := gen_random_uuid();
  v_session := gen_random_uuid();
  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  -- auth.users: no password, no identity — we bypass the email/password
  -- flow entirely. raw_app_meta_data carries the claims RLS checks.
  insert into auth.users (
    id, email, email_confirmed_at,
    raw_app_meta_data, aud, role,
    created_at, updated_at,
    instance_id
  )
  values (
    v_uid, v_email, now(),
    jsonb_build_object(
      'team_id', v_invite.team_id,
      'actor_id', v_invite.agent_id,
      'kind', 'daemon'
    ),
    'authenticated', 'authenticated',
    now(), now(),
    '00000000-0000-0000-0000-000000000000'
  );

  -- Active session paired with the refresh token.
  insert into auth.sessions (id, user_id, aal, created_at, updated_at)
    values (v_session, v_uid, 'aal1', now(), now());

  -- Classic (non-HMAC) refresh token. The project does not use the new
  -- rotating-HMAC scheme (auth.sessions.refresh_token_hmac_key is null for
  -- all existing sessions on this project).
  insert into auth.refresh_tokens (
    token, user_id, session_id, revoked,
    instance_id, created_at, updated_at
  )
  values (
    v_token, v_uid::text, v_session, false,
    '00000000-0000-0000-0000-000000000000', now(), now()
  );

  update public.agents set status = 'active' where id = v_invite.agent_id;

  update public.daemon_invites
    set claimed_at = now()
    where invite_token = p_invite_token;

  return query
    select v_invite.agent_id, v_invite.team_id, v_token;
end;
$$;

grant execute on function public.claim_daemon_invite(uuid) to anon, authenticated;
