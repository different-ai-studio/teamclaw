-- For ordinary-org first-team onboarding, prefer the team named after the
-- organization before falling back to the org's oldest team. This lets an org
-- explicitly designate its default team by naming it after the org, without
-- adding another mutable default-team pointer.
create or replace function amux.join_or_create_org_team(
  p_fallback_org        uuid default null,
  p_default_org_id      uuid default null,
  p_name                text default null,
  p_slug                text default null,
  p_display_name        text default null,
  p_litellm_team_id     text default null,
  p_ai_gateway_endpoint text default null
)
returns table(
  team_id        uuid,
  team_name      text,
  team_slug      text,
  member_id      uuid,
  role           text,
  workspace_id   uuid,
  workspace_name text
)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id      uuid := auth.uid();
  v_auth_org     uuid;
  v_org          uuid;
  v_team         uuid;
  v_member_id    uuid;
  v_nickname     text;
  v_display_name text;
  v_team_name    text;
  v_team_slug    text;
  v_workspace_id uuid;
  v_workspace_nm text;
  v_adjectives   text[] := array['Curious','Brave','Calm','Eager','Lively','Mellow','Nimble','Quick','Quiet','Sunny','Witty','Zesty','Bright','Daring','Gentle','Jolly','Keen','Plucky','Spry','Sparkling'];
  v_animals      text[] := array['Otter','Panda','Falcon','Fox','Heron','Lynx','Owl','Puffin','Quokka','Raven','Seal','Tapir','Viper','Walrus','Yak','Zebra','Badger','Cougar','Dolphin','Hare'];
begin
  if v_user_id is null then
    raise exception 'join_or_create_org_team requires an authenticated user' using errcode = '42501';
  end if;
  if exists (select 1 from amux.actors where user_id = v_user_id) then
    raise exception 'join_or_create_org_team currently supports first-team onboarding only'
      using errcode = '23514', detail = 'Existing actors already have a team-scoped identity.';
  end if;

  v_auth_org := amux.current_org_id();
  v_org := coalesce(v_auth_org, p_fallback_org);

  -- A team bearing the org name is the explicit default. When none exists,
  -- preserve the prior deterministic oldest-team fallback.
  if v_auth_org is not null and v_auth_org is distinct from p_default_org_id then
    select t.id into v_team
      from amux.teams t
     where t.oid = v_auth_org
     order by case when t.name = (select o.name from public.orgs o where o.id = v_auth_org)
                   then 0 else 1 end,
              t.created_at asc,
              t.id asc
     limit 1;
  end if;

  if v_team is null then
    return query
      select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
        from amux.create_team(
          p_name, p_slug, p_litellm_team_id, p_ai_gateway_endpoint, p_display_name, v_org
        ) c;
    return;
  end if;

  select nickname into v_nickname from public.users where id = v_user_id limit 1;
  v_member_id := gen_random_uuid();
  v_display_name := coalesce(
    nullif(btrim(v_nickname), ''),
    nullif(btrim(p_display_name), ''),
    v_adjectives[((hashtextextended(v_member_id::text, 11) % 20) + 20) % 20 + 1] || ' ' ||
    v_animals[((hashtextextended(v_member_id::text, 29) % 20) + 20) % 20 + 1]
  );

  insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
  values (v_member_id, v_team, 'member', v_user_id, v_display_name, now());
  insert into amux.members (id, status) values (v_member_id, 'active');
  insert into amux.team_members (team_id, member_id, role) values (v_team, v_member_id, 'member');

  select t.name, t.slug into v_team_name, v_team_slug from amux.teams t where t.id = v_team;
  select w.id, w.name into v_workspace_id, v_workspace_nm
    from amux.workspaces w
   where w.team_id = v_team
   order by w.created_at asc, w.id asc
   limit 1;

  return query
    select v_team, v_team_name, v_team_slug, v_member_id, 'member'::text, v_workspace_id, v_workspace_nm;
end;
$function$;

grant execute on function amux.join_or_create_org_team(uuid, uuid, text, text, text, text, text) to authenticated, service_role;
