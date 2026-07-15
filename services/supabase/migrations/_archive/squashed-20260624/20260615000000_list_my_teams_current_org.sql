-- Actor-scoped "my current teams" listing.
--
-- Bug: the default `GET /v1/teams` (FC supabase-repo.listTeams) returned every
-- team in the caller's current org via RLS (teams_org_guard) alone. A single org
-- can legitimately or accidentally contain teams the caller is NOT an actor in
-- (e.g. a mis-provisioned / shared "Personal" org where two users collided, or a
-- team created by another member before the caller joined). The desktop/web
-- client adopts `teams[0]` as the "current team"; when that team is one the
-- caller has no actor row in, every team-scoped RPC then fails — most visibly
-- `create_team_invite` raising "create_team_invite requires team membership"
-- during "Set Up this machine's agent" (daemon onboarding).
--
-- Fix: intersect org-scope with the caller's actor membership. SECURITY DEFINER
-- so it can read amux.actors regardless of the actors RLS surface, mirroring
-- amux.list_all_my_teams. Keeps org-scoping (current_org_id) so the adopted team
-- still matches the JWT's active org and downstream org-guarded writes succeed.
create or replace function amux.list_my_teams_current_org()
returns table(id uuid, name text, slug text, created_at timestamptz)
language sql
stable
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $$
  select t.id, t.name, t.slug, t.created_at
    from amux.teams t
   where t.oid is not distinct from amux.current_org_id()
     and exists (
       select 1 from amux.actors a
        where a.user_id = auth.uid()
          and a.team_id = t.id
     )
   order by t.created_at;
$$;

grant execute on function amux.list_my_teams_current_org() to anon, authenticated, service_role;
