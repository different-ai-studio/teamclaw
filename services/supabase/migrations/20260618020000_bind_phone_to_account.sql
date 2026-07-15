-- ============================================================================
-- Phone identity upgrade, betly-aligned (NOT GoTrue phone_change).
--
-- Binds a phone to the CURRENT account using our own verification code
-- (public.auth_verify_code, sent via /v1/auth/phone/send-code) and writes a
-- public.users row in the DEFAULT_ORG, so the phone↔user mapping matches what
-- /v1/auth/phone/login looks up. phone_change would only set auth.users.phone
-- without a public.users row, so a later phone login would miss it and create a
-- DUPLICATE betly user — this avoids that.
--
-- Also flips the auth user to non-anonymous (the actual "upgrade"). The caller's
-- JWT still reads is_anonymous=true until the session is refreshed.
--
-- See docs/specs/2026-06-17-teamclaw-phone-login-and-tenancy.md.
-- ============================================================================
create or replace function amux.bind_phone_to_account(
  p_phone text,
  p_code text,
  p_default_org_id uuid
)
returns table(user_id uuid, bound boolean)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_code_id uuid;
  v_other   uuid;
  v_nick    text;
begin
  if v_user_id is null then
    raise exception 'phone bind requires an authenticated user' using errcode = '42501';
  end if;
  if p_default_org_id is null then
    raise exception 'default org is required' using errcode = '23514';
  end if;

  -- Verify the code (our own auth_verify_code, same table phone login uses).
  select id into v_code_id
  from public.auth_verify_code
  where phone = p_phone and code = p_code and used = false and expires_at > now()
  order by created_at desc
  limit 1;
  if v_code_id is null then
    raise exception 'verification code is invalid or expired' using errcode = '23514';
  end if;

  -- The phone must not already belong to a DIFFERENT account in the default org.
  select id into v_other
  from public.users
  where org_id = p_default_org_id
    and mobile = p_phone
    and deleted_at is null
    and auth_user_id is distinct from v_user_id
  limit 1;
  if v_other is not null then
    raise exception 'phone already in use by another account' using errcode = '23505';
  end if;

  -- Upsert the current account's public.users row (mirror betly's shape).
  v_nick := 'betly_' || substr(md5(v_user_id::text || p_phone), 1, 4) || '_' || right(p_phone, 4);
  insert into public.users (id, org_id, auth_user_id, mobile, nickname)
  values (v_user_id, p_default_org_id, v_user_id, p_phone, v_nick)
  on conflict (id) do update
    set mobile = excluded.mobile,
        org_id = coalesce(public.users.org_id, excluded.org_id);

  -- Flip the auth user to a real (non-anonymous) phone identity.
  update auth.users set phone = p_phone, is_anonymous = false where id = v_user_id;

  -- Consume the code.
  update public.auth_verify_code set used = true, used_at = now() where id = v_code_id;

  return query select v_user_id, true;
end;
$function$;
