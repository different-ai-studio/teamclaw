-- Stop the session list from falling off a generic-plan cliff.
--
-- amux.list_current_actor_sessions is plpgsql, so its query plan is cached by
-- the SPI plan cache. PostgreSQL builds a custom plan for the first 5
-- executions, then compares the average custom cost against a generic plan and
-- switches if the generic one looks no worse. Here it always looks better and
-- always is worse. Measured on the self-host box (47.112.210.217), same
-- connection, same call, nothing else changing:
--
--     team sessions   executions 1-5   executions 6+
--     20,000          10 ms            1,310-1,416 ms
--     120,000         29-58 ms         9,913 ms  -> HTTP 500
--
-- The generic plan is wrong because it cannot see the parameters. With
-- p_before_* and p_idea_id unknown it estimates the sessions scan at rows=1, so
-- sorting looks free and it abandons the ordered index:
--
--     custom :  Index Scan using sessions_team_active_last_message_idx
--               (walks in ORDER BY order, stops at p_limit)
--     generic:  Index Scan using idx_sessions_team_id   (rows=1 estimated)
--                 -> 120,004 rows materialised, RLS evaluated on each
--                 -> Sort -> Limit
--
-- Since the `authenticated` role carries statement_timeout = 8s, the 120k case
-- does not merely get slow, it fails. And because PostgREST pools connections,
-- a backend is poisoned only after ITS 5th session-list call — which is why the
-- endpoint failed intermittently and looked like a load problem rather than a
-- planning one.
--
-- force_custom_plan is the right setting rather than a workaround: this
-- function's selectivity genuinely depends on its arguments (first page vs deep
-- cursor, idea-filtered vs not), which is precisely the case the mode exists
-- for. Re-planning costs ~1 ms against an execution that should be ~10-50 ms.
--
-- Idempotent: safe for the self-host apply-migrations loop to re-run.

ALTER FUNCTION amux.list_current_actor_sessions(
  p_team_id uuid,
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid,
  p_idea_id uuid
) SET plan_cache_mode = 'force_custom_plan';
