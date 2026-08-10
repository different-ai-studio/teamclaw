-- Retire the un-scoped session list.
--
-- 20260804020000 added amux.list_current_actor_sessions_all_teams as an
-- explicitly deprecated-on-arrival shim: FC redeploys on merge while desktop and
-- iOS ship on tags, so released builds that listed sessions without a teamId
-- needed something to call. Its own header said to delete it — and the function,
-- amux.current_actor_ids(), and the FC fallback — once no released client omits
-- teamId. GET /v1/sessions now rejects a missing teamId with a 400 and
-- supabase-repo no longer has the branch, so nothing calls either function.
--
-- Deleting it is not just tidying. Without a team there is no way to reach
-- sessions_team_active_last_message_idx, so the shim joined every participant
-- row the caller had, evaluated the sessions RLS policy on each, and only then
-- sorted and applied the limit. Measured on the self-host box (47.112.210.217)
-- against a seeded fixture:
--
--     caller's sessions   GET /v1/sessions (no teamId)
--     1,500               1.56 s
--     3,000               2.52 s
--     6,000               4.52 s
--     12,000              7.22 s
--     25,000              HTTP 500  (authenticated statement_timeout = 8s)
--     120,000             HTTP 500
--
-- The team-scoped RPC served the same first page in 90-200 ms at 120,000.
--
-- Leaving the function in place would let any future caller reintroduce that
-- curve silently. Dropping it turns the mistake into "function not found".
--
-- Idempotent: safe for the self-host apply-migrations loop to re-run.

DROP FUNCTION IF EXISTS amux.list_current_actor_sessions_all_teams(
  integer, timestamp with time zone, timestamp with time zone, uuid, uuid
);

-- Only ever existed to feed the shim above; no policy or function references it
-- (verified by grep across services/ and by this DROP, which fails rather than
-- cascading if something still depends on it).
DROP FUNCTION IF EXISTS amux.current_actor_ids();
