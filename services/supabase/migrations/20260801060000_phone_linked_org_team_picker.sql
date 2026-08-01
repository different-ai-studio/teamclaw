-- A phone is the identity link between a user's tenant accounts. The picker
-- must be complete per linked org, rather than mixing global public teams with
-- only the caller's single user_id membership.

create or replace function amux.list_teams_for_picker(
  p_default_org_id uuid default null,
  p_include_empty_orgs boolean default false
)
returns table(team_id uuid, team_name text, team_slug text, org_id uuid, org_name text, visibility text, is_member boolean, item_type text)
language sql stable security definer
set search_path to 'amux', 'public', 'auth'
as $$
  with current_identity as (
    select u.id, nullif(btrim(u.mobile), '') as mobile
      from public.users u
     where u.id = auth.uid()
     limit 1
  ), related_users as (
    -- Retain the caller even when a legacy record has no phone, then expand
    -- only through the shared phone when it is available.
    select auth.uid() as id
     where auth.uid() is not null
    union
    select u.id
      from public.users u
      join current_identity c on c.mobile is not null and u.mobile = c.mobile
  ), related_orgs as (
    select distinct u.org_id
      from public.users u
      join related_users ru on ru.id = u.id
     where u.org_id is not null
  ), member_teams as (
    select t.id, t.name, t.slug, t.oid, t.visibility, true as is_member, 'team'::text as item_type
      from amux.teams t
     where t.oid in (select org_id from related_orgs)
       and exists (
         select 1
           from amux.actors a
           join related_users ru on ru.id = a.user_id
          where a.team_id = t.id
       )
  ), public_teams as (
    select t.id, t.name, t.slug, t.oid, t.visibility, false as is_member, 'team'::text as item_type
      from amux.teams t
     where t.oid in (select org_id from related_orgs)
       and t.visibility = 'public'
       and not exists (
         select 1
           from amux.actors a
           join related_users ru on ru.id = a.user_id
          where a.team_id = t.id
       )
  ), empty_orgs as (
    select null::uuid as id, null::text as name, null::text as slug, o.id as oid,
           'private'::text as visibility, true as is_member, 'org'::text as item_type
      from public.orgs o
      join related_orgs ro on ro.org_id = o.id
     where p_include_empty_orgs
       and not exists (select 1 from amux.teams t where t.oid = o.id)
  )
  select * from (
    select t.id as team_id, t.name as team_name, t.slug as team_slug, t.oid as org_id,
           o.name as org_name, t.visibility, t.is_member, t.item_type
      from (
        select * from member_teams
        union all
        select * from public_teams
      ) t
      join public.orgs o on o.id = t.oid
    union all
    select e.id, e.name, e.slug, e.oid, o.name, e.visibility, e.is_member, e.item_type
      from empty_orgs e
      join public.orgs o on o.id = e.oid
  ) picker_items
  order by org_name nulls last, item_type, team_name;
$$;

grant execute on function amux.list_teams_for_picker(uuid, boolean) to authenticated, service_role;
