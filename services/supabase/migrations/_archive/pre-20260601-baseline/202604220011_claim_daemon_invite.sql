create or replace function public.claim_daemon_invite(
  p_invite_token uuid
)
returns table (
  agent_id uuid,
  team_id uuid,
  auth_email text,
  auth_password text
)
language plpgsql
security definer
set search_path = public, auth, app
as $$
declare
  v_invite record;
  v_uid uuid;
  v_email text;
  v_password text;
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

  -- Use a plausible-looking domain. Supabase hosted rejects .local TLDs and
  -- obvious test domains (example.com, localhost) in its anti-abuse filter.
  v_email := format('daemon.%s@amuxd.run', v_invite.agent_id);
  -- pgcrypto lives in the extensions schema on Supabase; qualify to avoid
  -- search_path surprises under SECURITY DEFINER.
  v_password := encode(extensions.gen_random_bytes(24), 'hex');

  insert into auth.users (
    id, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, aud, role,
    created_at, updated_at
  )
  values (
    gen_random_uuid(), v_email,
    extensions.crypt(v_password, extensions.gen_salt('bf')),
    now(),
    jsonb_build_object(
      'team_id', v_invite.team_id,
      'actor_id', v_invite.agent_id,
      'kind', 'daemon'
    ),
    'authenticated', 'authenticated',
    now(), now()
  )
  returning id into v_uid;

  -- GoTrue's password grant looks up the identity row keyed by
  -- (provider='email', provider_id=<email>). Without this, login_with_password
  -- returns 400 invalid_credentials.
  insert into auth.identities (
    id, user_id, provider, provider_id, identity_data,
    last_sign_in_at, created_at, updated_at
  )
  values (
    gen_random_uuid(), v_uid, 'email', v_email,
    jsonb_build_object(
      'sub', v_uid::text,
      'email', v_email,
      'email_verified', true,
      'phone_verified', false
    ),
    now(), now(), now()
  );

  update public.agents set status = 'active' where id = v_invite.agent_id;

  update public.daemon_invites
    set claimed_at = now()
    where invite_token = p_invite_token;

  return query
    select v_invite.agent_id, v_invite.team_id, v_email, v_password;
end;
$$;

grant execute on function public.claim_daemon_invite(uuid) to anon, authenticated;
