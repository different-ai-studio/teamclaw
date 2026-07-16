-- Org-default-team onboarding.
--
-- Tenancy behavior change for first-team onboarding (the AuthGate bootstrap
-- path that runs when a user logs in without an invite):
--
--   * DEFAULT_ORG (the partner's shared consumer tenant, DEFAULT_ORG_ID): each user
--     still gets their OWN independent solo team. Random individuals sharing
--     the default org must stay isolated — the previous behavior, preserved.
--
--   * A REAL customer org (e.g. a climbing gym like 香蕉攀岩): everyone who
--     bootstraps into that org should land in ONE shared team, not accumulate
--     one solo team per person. The org's default team is the OLDEST team in
--     the org (min created_at). The first person to bootstrap creates it (and
--     becomes its owner); everyone after joins it as a plain 'member'.
--
-- Invite-based joins are unaffected — amux.claim_team_invite still adds the
-- claimer to the inviting team. This function only governs the no-invite
-- bootstrap path, and is called by FC supabase-repo.createTeam in place of a
-- direct create_team call.
--
-- SECURITY DEFINER: the caller is not yet a member of the org's default team,
-- so the actor/member/team_member inserts must bypass the membership-scoped
-- RLS. The JOIN branch keys strictly off amux.current_org_id() (JWT org_id then
-- public.users.org_id) — the AUTHORITATIVE org from the verified token — so a
-- client calling this RPC directly cannot steer itself into another org's team.
-- p_fallback_org only stamps a NEWLY created team when the token carries no org
-- (preserves FC's ensure_personal_org / DEFAULT_ORG fallback); it never drives
-- a join.
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
  -- First-team-only, mirroring create_team: once the user has any actor they
  -- already have a team-scoped identity and must go through invites, not
  -- bootstrap.
  if exists (select 1 from amux.actors where user_id = v_user_id) then
    raise exception 'join_or_create_org_team currently supports first-team onboarding only'
      using errcode = '23514', detail = 'Existing actors already have a team-scoped identity.';
  end if;

  -- Authoritative org from the verified token (JWT org_id, then public.users).
  -- Drives the join decision; a client cannot override it.
  v_auth_org := amux.current_org_id();
  -- Org to stamp on a newly created team: authoritative org, else the
  -- FC-resolved fallback (DEFAULT_ORG_ID or a freshly provisioned personal org).
  v_org := coalesce(v_auth_org, p_fallback_org);

  -- Join only when the caller AUTHORITATIVELY belongs to a real, non-default
  -- org: adopt that org's default (oldest) team. Users with no token org, or in
  -- the shared DEFAULT_ORG, always fall through to create their own team.
  if v_auth_org is not null and v_auth_org is distinct from p_default_org_id then
    select t.id into v_team
      from amux.teams t
     where t.oid = v_auth_org
     order by t.created_at asc, t.id asc
     limit 1;
  end if;

  -- No shared team to join (default org, or the org's first-ever user):
  -- delegate to create_team so this caller gets/seeds a team as owner. In a
  -- non-default org that newly created team becomes the org's default (it is
  -- now the oldest), so subsequent users join it via the branch above.
  if v_team is null then
    return query
      select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
        from amux.create_team(
          p_name, p_slug, p_litellm_team_id, p_ai_gateway_endpoint, p_display_name, v_org
        ) c;
    return;
  end if;

  -- Join the shared default team as a plain member.
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

  -- Return the team's oldest workspace so the client has a workspace to adopt,
  -- matching create_team's return shape. May be null if the team has none.
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
