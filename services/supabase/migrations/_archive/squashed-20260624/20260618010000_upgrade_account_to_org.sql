-- ============================================================================
-- Account upgrade: graduate a user out of the shared DEFAULT_ORG into their own
-- org. Called when the user fills in an org name + contact (see
-- docs/specs/2026-06-17-teamclaw-phone-login-and-tenancy.md §8).
--
-- Atomically:
--   1. create a new public.orgs row (name + contact),
--   2. point public.users.org_id at it,
--   3. stamp auth.users app_metadata.org_id (so future JWTs / daemon see it),
--   4. reparent the caller's default-org team to the new org and rename it to
--      the org name.
--
-- Guards: caller must own p_team_id; the team must currently sit in the default
-- org (p_default_org_id) — re-upgrading a team already in a real org is rejected.
-- ============================================================================
create or replace function amux.upgrade_account_to_org(
  p_team_id uuid,
  p_org_name text,
  p_contact text default null::text,
  p_default_org_id uuid default null::uuid
)
returns table(org_id uuid, team_id uuid, team_name text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth'
as $function$
declare
  v_user_id   uuid := auth.uid();
  v_member_id uuid;
  v_org_id    uuid := gen_random_uuid();
  v_team_oid  uuid;
  v_mobile    text;
  v_name      text := btrim(p_org_name);
begin
  if v_user_id is null then
    raise exception 'upgrade requires an authenticated user' using errcode = '42501';
  end if;
  if v_name is null or v_name = '' then
    raise exception 'org name is required' using errcode = '23514';
  end if;

  -- Caller must be the OWNER of the team being upgraded.
  select tm.member_id into v_member_id
  from amux.team_members tm
  join amux.actors a on a.id = tm.member_id
  where tm.team_id = p_team_id and a.user_id = v_user_id and tm.role = 'owner'
  limit 1;
  if v_member_id is null then
    raise exception 'only the team owner can upgrade' using errcode = '42501';
  end if;

  -- The team must currently live in the default org (idempotency / re-upgrade guard).
  select oid into v_team_oid from amux.teams where id = p_team_id;
  if p_default_org_id is not null and v_team_oid is distinct from p_default_org_id then
    raise exception 'team already belongs to its own org' using errcode = '23514';
  end if;

  select mobile into v_mobile from public.users where id = v_user_id limit 1;

  -- 1. New org.
  insert into public.orgs (id, name, contact, phone)
  values (v_org_id, v_name, nullif(btrim(p_contact), ''), v_mobile);

  -- 2. Point the user's profile at the new org.
  update public.users set org_id = v_org_id where id = v_user_id;

  -- 3. Stamp the JWT org claim source so daemon / team-share resolve the new org.
  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('org_id', v_org_id::text)
  where id = v_user_id;

  -- 4. Reparent + rename the team.
  update amux.teams set oid = v_org_id, name = v_name where id = p_team_id;

  return query select v_org_id, p_team_id, v_name;
end;
$function$;
