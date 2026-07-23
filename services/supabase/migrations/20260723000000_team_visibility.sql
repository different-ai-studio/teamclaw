-- Team visibility (public | private) + public-team discovery/join.
--
-- Goal: within the shared DEFAULT_ORG, teams marked `public` are discoverable by
-- every user in that org and can be joined self-service from the post-login team
-- picker. Private teams stay invite/bootstrap-only, exactly as before.
--
--   * amux.teams.visibility: 'private' (default) | 'public'.
--   * amux.list_teams_for_picker(p_default_org_id): the picker's data source —
--     union of (a) teams the caller is already an actor in (is_member=true) and
--     (b) public teams in the default org the caller is NOT yet in
--     (is_member=false).
--   * amux.join_public_team(p_team_id, p_default_org_id): self-service join of a
--     public default-org team as a plain 'member'. Unlike the first-team
--     bootstrap RPCs, this DOES support users who already have an actor (this is
--     their Nth team), so it must NOT reuse the first-team-only guard.
--
-- FC passes DEFAULT_ORG_ID as p_default_org_id, mirroring the other onboarding
-- RPCs, so the default org is never client-steerable.

alter table amux.teams
  add column if not exists visibility text not null default 'private';

alter table amux.teams
  drop constraint if exists teams_visibility_check;
alter table amux.teams
  add constraint teams_visibility_check
  check (visibility in ('public', 'private'));

-- Fast lookup of public teams within a given (default) org.
create index if not exists idx_teams_default_org_public
  on amux.teams (oid)
  where visibility = 'public';


-- Picker data source: my teams (any org) ∪ public teams in the default org.
create or replace function amux.list_teams_for_picker(p_default_org_id uuid default null)
  returns table(team_id uuid, team_name text, team_slug text, org_id uuid, org_name text, visibility text, is_member boolean)
  language sql stable security definer
  set search_path to 'amux', 'public', 'auth'
  as $$
  with mine as (
    select t.id, t.name, t.slug, t.oid, t.visibility, true as is_member
      from amux.teams t
     where exists (
       select 1 from amux.actors a
        where a.user_id = auth.uid() and a.team_id = t.id
     )
  ),
  public_default as (
    select t.id, t.name, t.slug, t.oid, t.visibility, false as is_member
      from amux.teams t
     where p_default_org_id is not null
       and t.oid = p_default_org_id
       and t.visibility = 'public'
       and not exists (
         select 1 from amux.actors a
          where a.user_id = auth.uid() and a.team_id = t.id
       )
  ),
  combined as (
    select * from mine
    union all
    select * from public_default
  )
  select c.id, c.name, c.slug, c.oid, o.name, c.visibility, c.is_member
    from combined c
    left join public.orgs o on o.id = c.oid
   order by c.is_member desc, o.name nulls last, c.name;
$$;

grant execute on function amux.list_teams_for_picker(uuid) to authenticated, service_role;


-- Self-service join of a public default-org team as a plain member.
create or replace function amux.join_public_team(p_team_id uuid, p_default_org_id uuid default null)
  returns table(
    team_id        uuid,
    team_name      text,
    team_slug      text,
    member_id      uuid,
    role           text,
    workspace_id   uuid,
    workspace_name text
  )
  language plpgsql security definer
  set search_path to 'amux', 'public', 'auth', 'extensions'
  as $$
declare
  v_user_id      uuid := auth.uid();
  v_team         amux.teams%rowtype;
  v_member_id    uuid;
  v_existing     uuid;
  v_nickname     text;
  v_display_name text;
  v_workspace_id uuid;
  v_workspace_nm text;
  v_adjectives   text[] := array['Curious','Brave','Calm','Eager','Lively','Mellow','Nimble','Quick','Quiet','Sunny','Witty','Zesty','Bright','Daring','Gentle','Jolly','Keen','Plucky','Spry','Sparkling'];
  v_animals      text[] := array['Otter','Panda','Falcon','Fox','Heron','Lynx','Owl','Puffin','Quokka','Raven','Seal','Tapir','Viper','Walrus','Yak','Zebra','Badger','Cougar','Dolphin','Hare'];
begin
  if v_user_id is null then
    raise exception 'join_public_team requires an authenticated user' using errcode = '42501';
  end if;

  select * into v_team from amux.teams where id = p_team_id;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;

  -- Only public teams in the default org are self-service joinable. Anything
  -- else must go through invites or bootstrap.
  if v_team.visibility is distinct from 'public'
     or p_default_org_id is null
     or v_team.oid is distinct from p_default_org_id then
    raise exception 'team is not a joinable public team'
      using errcode = '42501';
  end if;

  -- Idempotent: if already an actor in this team, just return the existing row.
  select a.id into v_existing
    from amux.actors a
   where a.user_id = v_user_id and a.team_id = p_team_id
   limit 1;

  if v_existing is not null then
    v_member_id := v_existing;
  else
    select nickname into v_nickname from public.users where id = v_user_id limit 1;

    v_member_id := gen_random_uuid();
    v_display_name := coalesce(
      nullif(btrim(v_nickname), ''),
      v_adjectives[((hashtextextended(v_member_id::text, 11) % 20) + 20) % 20 + 1] || ' ' ||
      v_animals[((hashtextextended(v_member_id::text, 29) % 20) + 20) % 20 + 1]
    );

    insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
    values (v_member_id, p_team_id, 'member', v_user_id, v_display_name, now());
    insert into amux.members (id, status) values (v_member_id, 'active');
    insert into amux.team_members (team_id, member_id, role) values (p_team_id, v_member_id, 'member');
  end if;

  select w.id, w.name into v_workspace_id, v_workspace_nm
    from amux.workspaces w
   where w.team_id = p_team_id
   order by w.created_at asc, w.id asc
   limit 1;

  return query
    select v_team.id, v_team.name, v_team.slug, v_member_id, 'member'::text, v_workspace_id, v_workspace_nm;
end;
$$;

grant execute on function amux.join_public_team(uuid, uuid) to authenticated, service_role;
