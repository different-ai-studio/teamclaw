-- Give the team picker enough to tell same-named teams apart.
--
-- bootstrap_current_org_team names the team it creates after the org, and it
-- deliberately never joins an org's existing team (pgTAP 027 asserts exactly
-- that: 'bootstrap does not silently join an existing org team'). create_team
-- then uniquifies the SLUG in a loop and leaves the NAME alone — amux.teams has
-- a unique index on slug and none on name. So every additional person who
-- onboards into an org mints another team carrying the org's name, and the
-- picker renders them as identical rows.
--
-- This is not hypothetical: one org on a live deployment has four teams all
-- called the same thing, created by four different people over two months, with
-- 68 / 2 / 1 / 24 actors respectively. A member of two of them sees two
-- indistinguishable buttons and no way to tell which is the one with their 484
-- sessions in it.
--
-- The slug does not rescue the display either. It is built from
-- lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-')), so an all-CJK name reduces
-- to an empty string and falls back to the literal 'team' — every Chinese-named
-- team on the deployment therefore shares one global `team-N` sequence and the
-- slug carries no information about which team it is.
--
-- So return the three things a human actually recognises a team by: when it was
-- made, who owns it, and how many people are in it. The picker shows them only
-- for rows whose name is ambiguous, so the ordinary single-team case is
-- unchanged.
--
-- Nothing about team creation changes here — this migration only widens a
-- read-only listing. Whether an org should be able to accumulate same-named
-- teams at all is a separate question from whether the picker can survive it.
--
-- The return type grows, so this is DROP + CREATE rather than CREATE OR REPLACE,
-- which means the grants have to be restored explicitly (a recreated function
-- keeps only the default EXECUTE-to-PUBLIC).
--
-- Body is otherwise carried forward verbatim from
-- 20260807040000_picker_lists_own_teams_without_org_row.sql.

drop function if exists amux.list_teams_for_picker(uuid, boolean);

create function amux.list_teams_for_picker(
  p_default_org_id uuid default null,
  p_include_empty_orgs boolean default false
)
returns table(team_id uuid, team_name text, team_slug text, org_id uuid, org_name text,
              visibility text, is_member boolean, item_type text,
              created_at timestamptz, member_count integer, owner_name text)
language sql
stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
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
    -- No org filter: an actor in the team is the membership.
    select t.id, t.name, t.slug, t.oid, t.visibility, true as is_member, 'team'::text as item_type,
           t.created_at
      from amux.teams t
     where exists (
         select 1
           from amux.actors a
           join related_users ru on ru.id = a.user_id
          where a.team_id = t.id
       )
  ), public_teams as (
    select t.id, t.name, t.slug, t.oid, t.visibility, false as is_member, 'team'::text as item_type,
           t.created_at
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
           'private'::text as visibility, true as is_member, 'org'::text as item_type,
           null::timestamptz as created_at
      from public.orgs o
      join related_orgs ro on ro.org_id = o.id
     where p_include_empty_orgs
       and not exists (select 1 from amux.teams t where t.oid = o.id)
  )
  select * from (
    select t.id as team_id, t.name as team_name, t.slug as team_slug, t.oid as org_id,
           o.name as org_name, t.visibility, t.is_member, t.item_type,
           t.created_at,
           -- Counted here rather than client-side: the picker runs before the
           -- caller has switched into the team, so a per-team member listing
           -- would be blocked by RLS for exactly the rows worth disambiguating.
           -- This function is SECURITY DEFINER, so the count is accurate even
           -- for a public team the caller has not joined.
           (select count(*)::int
              from amux.actors a
             where a.team_id = t.id and a.actor_type = 'member') as member_count,
           (select a.display_name
              from amux.team_members tm
              join amux.actors a on a.id = tm.member_id
             where tm.team_id = t.id and tm.role = 'owner'
             order by a.created_at asc, a.id asc
             limit 1) as owner_name
      from (
        select * from member_teams
        union all
        select * from public_teams
      ) t
      join public.orgs o on o.id = t.oid
    union all
    select e.id, e.name, e.slug, e.oid, o.name, e.visibility, e.is_member, e.item_type,
           e.created_at, null::int, null::text
      from empty_orgs e
      join public.orgs o on o.id = e.oid
  ) picker_items
  -- created_at/team_id only break ties the previous ORDER BY left open, so no
  -- pair that was already ordered moves. Same-named teams used to come back in
  -- whatever order the plan produced, which made the picker reshuffle between
  -- loads — the one thing worse than two identical buttons is two identical
  -- buttons that swap places.
  order by org_name nulls last, item_type, team_name, created_at nulls last, team_id;
$function$;

grant execute on function amux.list_teams_for_picker(uuid, boolean) to authenticated, service_role;

comment on function amux.list_teams_for_picker(uuid, boolean) is
  'Cross-org team picker source: teams the caller holds an actor in, plus public teams in their orgs they could join. Also returns created_at / member_count / owner_name so the client can disambiguate teams that share a name (an org''s teams are all named after the org).';
