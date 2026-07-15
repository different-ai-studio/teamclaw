-- ============================================================================
-- Stage 3B of teamclaw × saas-mono integration (depends on the amux move)
-- (spec: docs/specs/2026-06-08-teamclaw-saas-mono-integration.md)
--
-- ⚠️ APPLY ONLY AFTER / WITH Stage 2 (needs amux.teams + amux.actors).
--    Validated by dry-run layered on Stage 2 (rollback). The amux_access_token_hook
--    is the GoTrue login hook — changing it on a live instance risks login outage;
--    test on testsupa and verify a login before prod cutover.
--
--   - app.ensure_org_default_team(): provision one default team per org (oid set)
--   - amux_access_token_hook: inject app_metadata.org_id into the JWT
--   - teams_org_guard: restrictive RLS so a team is only visible/writable within
--     its org (defense-in-depth on top of app.is_team_member)
-- ============================================================================

-- Provision a default teamclaw team under an org (idempotent). SECURITY DEFINER
-- so it bypasses the org-guard RLS during provisioning.
create or replace function app.ensure_org_default_team(p_org_id uuid, p_name text default null)
returns uuid
language plpgsql security definer
set search_path = amux, public, auth
as $$
declare
  v_team uuid;
begin
  select id into v_team from amux.teams where oid = p_org_id order by created_at limit 1;
  if v_team is not null then
    return v_team;
  end if;
  insert into amux.teams (slug, name, oid)
  values ('org-' || replace(p_org_id::text, '-', ''), coalesce(p_name, 'Default'), p_org_id)
  returning id into v_team;
  return v_team;
end;
$$;

-- GoTrue access-token hook: keep existing acl + memberships, ADD app_metadata.org_id.
create or replace function public.amux_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
declare
  v_user_id     uuid;
  v_claims      jsonb;
  v_memberships jsonb;
  v_acl         jsonb;
  v_org         uuid;
begin
  v_user_id := nullif(event->>'user_id','')::uuid;
  if v_user_id is null then
    return event;
  end if;
  v_claims := coalesce(event->'claims', '{}'::jsonb);

  select coalesce(
    jsonb_agg(jsonb_build_object(
      'team_id', a.team_id::text, 'actor_id', a.id::text, 'actor_type', a.actor_type
    ) order by a.team_id, a.id),
    '[]'::jsonb)
    into v_memberships
    from amux.actors a where a.user_id = v_user_id;

  with expanded as (
    select jsonb_build_object('permission','allow','action',r.action,'topic',r.topic) as rule
      from amux.actors a,
           lateral public.amux_acl_rules_for(a.team_id, a.id, a.actor_type) r
     where a.user_id = v_user_id
  )
  select coalesce(jsonb_agg(rule), '[]'::jsonb)
         || jsonb_build_array(jsonb_build_object('permission','deny','action','all','topic','#'))
    into v_acl from expanded;

  -- org_id: keep existing claim if present, else resolve from public.users
  v_org := coalesce(
    nullif(v_claims->'app_metadata'->>'org_id','')::uuid,
    (select u.org_id from public.users u where u.auth_user_id = v_user_id limit 1)
  );

  v_claims := v_claims
    || jsonb_build_object('acl', v_acl)
    || jsonb_build_object('app_metadata',
         coalesce(v_claims->'app_metadata', '{}'::jsonb)
         || jsonb_build_object('memberships', v_memberships)
         || case when v_org is not null then jsonb_build_object('org_id', v_org::text) else '{}'::jsonb end
       );

  return jsonb_build_object('claims', v_claims);
exception when others then
  return event;
end;
$function$;

-- Restrictive org guard on teams: ANDed with existing team-scoped policies.
-- oid is null tolerated during transition (teams created before oid backfill).
drop policy if exists teams_org_guard on amux.teams;
create policy teams_org_guard on amux.teams as restrictive
  using      (oid is null or oid = (select app.current_org_id()))
  with check (oid is null or oid = (select app.current_org_id()));
