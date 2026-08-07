-- Let an anonymous user bootstrap their own first team.
--
-- The product wants a try-before-signup path: an anonymous sign-in lands the
-- user in the shared DEFAULT_ORG with a team of their own, and attaching an
-- email identity later upgrades the same auth user in place, so the team and
-- everything in it survives the upgrade.
--
-- Only this one guard is lifted. `join_public_team` keeps refusing anonymous
-- callers: browsing a public team must never put a guest into somebody else's
-- member list, which is the invariant the guest-discovery screen states
-- ("Guest browsing never creates an actor"). Making your own team does not
-- touch anyone else's.
--
-- `create_team`'s first-team-only check still applies and is what bounds this:
-- an anonymous user has no actors, gets exactly one team, and cannot make a
-- second.
create or replace function amux.bootstrap_current_org_team(
  p_fallback_org uuid default null,
  p_display_name text default null
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_org_name text;
  v_is_anonymous boolean;
begin
  if v_user_id is null then
    raise exception 'bootstrap_current_org_team requires an authenticated user' using errcode = '42501';
  end if;

  -- Serialize bootstrap per user; create_team itself checks first-team-only.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  if exists (select 1 from amux.actors where user_id = v_user_id) then
    raise exception 'bootstrap_current_org_team currently supports first-team onboarding only'
      using errcode = '23514';
  end if;

  -- Anonymous users have no public.users row, so current_org_id() is null and
  -- the fallback (FC passes DEFAULT_ORG_ID) is what places them in the shared
  -- org. Without a DEFAULT_ORG_ID configured they still get the same error as
  -- before rather than a team in no org.
  v_org_id := coalesce(amux.current_org_id(), p_fallback_org);
  if v_org_id is null then
    raise exception 'current organization is required for team bootstrap' using errcode = '23514';
  end if;
  select coalesce(is_anonymous, false) into v_is_anonymous from auth.users where id = v_user_id;

  select name into v_org_name from public.orgs where id = v_org_id;
  if nullif(btrim(v_org_name), '') is null then
    raise exception 'current organization has no name' using errcode = '23514';
  end if;

  -- Guests get a random name, not the org name. Every guest team lives in the
  -- one shared org, so naming them after it produces a pile of teams that are
  -- all called the same thing and share a slug. Passing NULL lets create_team
  -- mint its Adjective Animal, which is what its own comment says should
  -- happen for exactly this reason. Signed-in users keep the org name: their
  -- org is theirs, so it is a meaningful team name.
  return query
    select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
      from amux.create_team(
        p_name => case when v_is_anonymous then null else v_org_name end,
        p_display_name => p_display_name,
        p_oid => v_org_id
      ) c;
end;
$function$;
