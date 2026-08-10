-- Rewrite the sessions SELECT policy so it stops calling a SECURITY DEFINER
-- function four times per row.
--
-- The policy read:
--
--     is_team_member(team_id)                                       -- call #1
--     AND ( created_by_actor_id = current_actor_id_for_team(team_id) -- #2
--        OR primary_agent_id   = current_actor_id_for_team(team_id) -- #3
--        OR is_session_participant(id) )                            -- #4
--
-- Every one of those is SECURITY DEFINER, so none can be inlined and all four
-- run per candidate row. Scanning the sessions of the heaviest user in the
-- database (1,162 visible of 2,066) measured 58.8 ms; the predicate below
-- measured 4.1 ms on the same identity and returned the same rows — 14x, and
-- the plan changes from a per-row filter into a materialised actor set plus a
-- bitmap index scan.
--
-- TWO SIMPLIFICATIONS, BOTH RESTING ON EXISTING SCHEMA INVARIANTS
--
-- 1. `is_team_member(team_id)` is redundant. Each branch names an actor, and
--    enforce_core_team_integrity pins sessions.created_by_actor_id and
--    sessions.primary_agent_id to the session's team (as it does for
--    participants). So "that actor is mine" already implies "I have an actor in
--    this team" — precisely what is_team_member checked. Verified over the whole
--    database: 0 sessions whose created_by_actor_id is in another team, 0 whose
--    primary_agent_id is.
--
-- 2. `= current_actor_id_for_team(team_id)` becomes `IN (<my actors>)`. With
--    unique (team_id, user_id) on actors plus the same-team pinning above, "is
--    my actor in that team" and "is one of my actors" select the same rows. The
--    set form is what matters: it takes no per-row argument, so the planner
--    evaluates it once per query instead of calling a function per row.
--
-- `is_session_participant(id)` stays as it is. It is still SECURITY DEFINER and
-- therefore still per-row; removing that costs a rework of the
-- sessions/session_participants policy recursion, which is deliberately not
-- attempted here (see 20260810040000's header for why the obvious version
-- widens visibility).
--
-- Idempotent: safe for the self-host apply-migrations loop to re-run.

-- ---------------------------------------------------------------------------
-- 1. The caller's actors, as a set the planner can hoist
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because it reads amux.actors, whose own SELECT policy calls
-- is_team_member — going through RLS here would reintroduce the per-row cost
-- this migration exists to remove.
--
-- Returns SETOF rather than uuid[] so callers write `IN (SELECT ...)`, the form
-- the planner turns into a single hashed evaluation. `= ANY ((SELECT f()))`
-- does NOT work: PostgreSQL reads the parenthesised SELECT as a sub-SELECT
-- rather than an array and fails with "operator does not exist: uuid = uuid[]".
--
-- A function of this name existed until 20260810010000, which dropped it along
-- with the un-scoped session list it fed. This one serves a different purpose
-- and is not tied to that shim.

DROP FUNCTION IF EXISTS amux.current_actor_ids();
CREATE FUNCTION amux.current_actor_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select id from amux.actors where user_id = auth.uid()
$$;

REVOKE ALL ON FUNCTION amux.current_actor_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION amux.current_actor_ids() TO authenticated;
GRANT ALL ON FUNCTION amux.current_actor_ids() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The policy
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS sessions_select_if_participant_or_creator ON amux.sessions;
CREATE POLICY sessions_select_if_participant_or_creator ON amux.sessions
  FOR SELECT TO authenticated
  USING (
    created_by_actor_id IN (SELECT amux.current_actor_ids())
    OR primary_agent_id IN (SELECT amux.current_actor_ids())
    OR amux.is_session_participant(id)
  );
