-- ============================================================================
-- Stage 3-FC.2: anonymous / first-login lazy provisioning of a personal org
-- (spec: docs/specs/2026-06-08-teamclaw-saas-mono-integration.md §8)
--
-- public-only + additive → safe to apply now (no amux dependency).
--
-- An anonymous (or any) user with no org gets a personal org of one. Called by
-- FC in the createTeam path (and bootstrap) when the token has no org_id, so the
-- caller's first team is stamped with a real org (strict single-org).
-- The amux_access_token_hook then surfaces org_id into the JWT from public.users.
-- ============================================================================

-- One auth user ↔ one org row (strict single-org). Enables safe race handling.
create unique index if not exists uq_users_auth_user_id
  on public.users (auth_user_id) where auth_user_id is not null;

create or replace function public.ensure_personal_org()
returns uuid
language plpgsql security definer
set search_path = public, auth, app
as $$
declare
  v_user uuid := auth.uid();
  v_org  uuid;
begin
  if v_user is null then
    raise exception 'ensure_personal_org requires an authenticated user' using errcode = '42501';
  end if;

  select org_id into v_org from public.users where auth_user_id = v_user limit 1;
  if v_org is not null then
    return v_org;
  end if;

  insert into public.orgs (name) values ('Personal') returning id into v_org;
  begin
    insert into public.users (auth_user_id, org_id) values (v_user, v_org);
  exception when unique_violation then
    -- lost a concurrent race: drop our org, reuse the winner's
    delete from public.orgs where id = v_org;
    select org_id into v_org from public.users where auth_user_id = v_user limit 1;
  end;

  return v_org;
end;
$$;
