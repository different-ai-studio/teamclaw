-- Empty-org picker rows must be limited to orgs that belong to the current
-- user. `public.users` can contain more than one row for the same auth user
-- (one per tenant), linked by either id or auth_user_id.

create or replace function amux.list_teams_for_picker(
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
  ), user_orgs as (
    select distinct u.org_id
      from public.users u
     where u.org_id is not null
       and (u.id = auth.uid() or u.auth_user_id = auth.uid())
       and coalesce(u.deleted_at, null) is null
    union
    select distinct t.oid
      from amux.actors a
      join amux.teams t on t.id = a.team_id
     where a.user_id = auth.uid() and t.oid is not null
  ), empty_orgs as (
    select null::uuid as id, null::text as name, null::text as slug, o.id as oid,
           'private'::text as visibility, true as is_member, 'org'::text as item_type
      from public.orgs o
      join user_orgs uo on uo.org_id = o.id
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
