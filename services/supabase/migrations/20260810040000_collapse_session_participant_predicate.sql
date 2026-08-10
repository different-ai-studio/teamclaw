-- Collapse the nested SECURITY DEFINER calls in the session-participant
-- predicate.
--
-- amux.is_session_participant is the most-evaluated expression in the schema —
-- it gates SELECT on messages and on sessions, so it runs once per candidate
-- row. Measured on the self-host box, the same 12k-row message query costs
-- 18.5 ms as `postgres` (RLS off) and 2,654 ms as `authenticated`: a 143x
-- penalty, essentially all of it this predicate.
--
-- Two things make it expensive. This migration fixes the one that can be fixed
-- safely; see the note at the bottom for the other.
--
-- The body called two MORE SECURITY DEFINER functions:
--
--     select exists (
--       select 1 from amux.sessions s
--       where s.id = target_session_id
--         and amux.is_team_member(s.team_id)                        -- call #2
--         and exists (select 1 from amux.session_participants sp
--                     where sp.session_id = s.id
--                       and sp.actor_id =
--                           amux.current_actor_id_for_team(s.team_id)))  -- call #3
--
-- so every evaluation was 3 function calls and ~4 index lookups. Collapsing it
-- to a single join measured, on real data:
--
--     2000 calls                 617 ms -> 34.8 ms   (17.7x)
--     filtering a session's msgs  32.6 ms -> 5.6 ms  (5.8x)
--
-- WHY THE COLLAPSED FORM IS EQUIVALENT
--
-- Old: "there is a session S = target, I have an actor in S's team, and that
--       actor participates in S".
-- New: "one of my actors participates in the session".
--
-- Two invariants already in the schema make these the same set of rows:
--   * amux.actors has unique (team_id, user_id) — one actor per user per team;
--   * enforce_session_participants_same_team forces a participant's actor to
--     belong to the session's team.
-- So at most one of my actors can appear in any session's participant list, and
-- if it does, its team IS the session's team — which is exactly what
-- is_team_member(s.team_id) was checking. Same argument 20260804020000 makes in
-- its own header.
--
-- Verified on the live database rather than argued only: the invariant holds
-- (0 participant rows whose actor is in a different team than the session), the
-- two predicates disagree on 0 of every session, and the visible row counts for
-- messages / sessions / session_participants are identical before and after for
-- every sampled user.
--
-- WHAT IS DELIBERATELY *NOT* DONE HERE
--
-- The other half of the cost is that a SECURITY DEFINER SQL function cannot be
-- inlined by PostgreSQL, so this predicate is a real per-row function call
-- rather than something the planner can fold into a semi-join and evaluate
-- once. Making it SECURITY INVOKER requires session_participants' SELECT policy
-- to stop routing through amux.sessions (otherwise the policies recurse), and
-- that policy cannot be restated without it: it reads
--
--     EXISTS (SELECT 1 FROM amux.sessions s
--              WHERE s.id = sp.session_id AND is_team_member(s.team_id))
--
-- which looks like a plain team check but is not — the subquery reads
-- amux.sessions, so it is itself filtered by sessions' RLS, and the policy
-- therefore means "a session I can SEE (participant, creator, or primary
-- agent)". Dropping the sessions reference drops that condition. Tried and
-- measured: visibility widened from 143 to 2659 participant rows for one
-- sampled user. `created_by_actor_id` / `primary_agent_id` live only on
-- amux.sessions, so the condition cannot be expressed without reading it.
-- Inlining therefore needs a rethink of sessions' visibility model, not a
-- rewrite of this predicate.
--
-- Idempotent: safe for the self-host apply-migrations loop to re-run.

CREATE OR REPLACE FUNCTION amux.is_session_participant(target_session_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select exists (
      select 1
      from amux.session_participants sp
      join amux.actors a on a.id = sp.actor_id
      where sp.session_id = target_session_id
        and a.user_id = auth.uid()
    )
$$;
