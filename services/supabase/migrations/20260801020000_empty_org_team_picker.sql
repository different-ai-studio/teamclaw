-- Let the authenticated desktop picker show tenant orgs which have no team
-- yet. Selecting one creates its org-named owner team in a single transaction.

drop function if exists amux.list_teams_for_picker(uuid);

create function amux.list_teams_for_picker(
  p_default_org_id uuid default null,
  p_include_empty_orgs boolean default false
)
returns table(
  team_id uuid,
  team_name text,
  team_slug text,
  org_id uuid,
  org_name text,
  visibility text,
  is_member boolean,
  item_type text
)
language sql stable security definer
set search_path to 'amux', 'public', 'auth'
as $$
  with mine as (
    select t.id, t.name, t.slug, t.oid, t.visibility, true as is_member, 'team'::text as item_type
      from amux.teams t
     where exists (select 1 from amux.actors a where a.user_id = auth.uid() and a.team_id = t.id)
  ), public_teams as (
    select t.id, t.name, t.slug, t.oid, t.visibility, false as is_member, 'team'::text as item_type
      from amux.teams t
     where t.visibility = 'public'
       and not exists (select 1 from amux.actors a where a.user_id = auth.uid() and a.team_id = t.id)
  ), combined as (
    select * from mine union all select * from public_teams
  ), empty_orgs as (
    select null::uuid as id, null::text as name, null::text as slug, o.id as oid,
           'private'::text as visibility, true as is_member, 'org'::text as item_type
      from public.orgs o
     where p_include_empty_orgs
       and not exists (select 1 from amux.teams t where t.oid = o.id)
  )
  select * from (
    select c.id as team_id, c.name as team_name, c.slug as team_slug, c.oid as org_id,
           o.name as org_name, c.visibility, c.is_member, c.item_type
      from combined c
      left join public.orgs o on o.id = c.oid
    union all
    select e.id, e.name, e.slug, e.oid, o.name, e.visibility, e.is_member, e.item_type
      from empty_orgs e
      join public.orgs o on o.id = e.oid
  ) picker_items
  order by item_type, org_name nulls last, team_name;
$$;

grant execute on function amux.list_teams_for_picker(uuid, boolean) to authenticated, service_role;

create or replace function amux.bootstrap_selected_org_team(
  p_org_id uuid,
  p_display_name text default null
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_org_name text;
  v_team_id uuid := gen_random_uuid();
  v_member_id uuid := gen_random_uuid();
  v_workspace_id uuid;
  v_slug_base text;
  v_slug text;
  v_suffix integer := 1;
  v_nickname text;
  v_display_name text;
  v_adjectives text[] := array['Curious','Brave','Calm','Eager','Lively','Mellow','Nimble','Quick','Quiet','Sunny','Witty','Zesty','Bright','Daring','Gentle','Jolly','Keen','Plucky','Spry','Sparkling'];
  v_animals text[] := array['Otter','Panda','Falcon','Fox','Heron','Lynx','Owl','Puffin','Quokka','Raven','Seal','Tapir','Viper','Walrus','Yak','Zebra','Badger','Cougar','Dolphin','Hare'];
begin
  if v_user_id is null then
    raise exception 'bootstrap_selected_org_team requires an authenticated user' using errcode = '42501';
  end if;
  if exists (select 1 from auth.users where id = v_user_id and coalesce(is_anonymous, false)) then
    raise exception 'anonymous users cannot bootstrap a team' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
  select name into v_org_name from public.orgs where id = p_org_id;
  if nullif(btrim(v_org_name), '') is null then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from amux.teams where oid = p_org_id) then
    raise exception 'organization already has a team' using errcode = '23505';
  end if;

  v_slug_base := lower(regexp_replace(v_org_name, '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug_base := trim(both '-' from v_slug_base);
  if v_slug_base = '' then v_slug_base := 'team'; end if;
  v_slug := v_slug_base;
  while exists (select 1 from amux.teams where slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := format('%s-%s', v_slug_base, v_suffix);
  end loop;
  select nickname into v_nickname from public.users where id = v_user_id limit 1;
  v_display_name := coalesce(nullif(btrim(v_nickname), ''), nullif(btrim(p_display_name), ''),
    v_adjectives[((hashtextextended(v_member_id::text, 11) % 20 + 20) % 20) + 1] || ' ' ||
    v_animals[((hashtextextended(v_member_id::text, 29) % 20 + 20) % 20) + 1]);

  insert into amux.teams (id, name, slug, oid) values (v_team_id, v_org_name, v_slug, p_org_id);
  insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
    values (v_member_id, v_team_id, 'member', v_user_id, v_display_name, now());
  insert into amux.members (id, status) values (v_member_id, 'active');
  insert into amux.team_members (team_id, member_id, role) values (v_team_id, v_member_id, 'owner');
  insert into amux.workspaces (team_id, created_by_member_id, name, path)
    values (v_team_id, v_member_id, 'General', null) returning id into v_workspace_id;
  insert into amux.team_workspace_config (team_id) values (v_team_id);
  return query select v_team_id, v_org_name, v_slug, v_member_id, 'owner'::text, v_workspace_id, 'General'::text;
end;
$function$;

grant execute on function amux.bootstrap_selected_org_team(uuid, text) to authenticated, service_role;
