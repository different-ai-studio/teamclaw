-- Look the caller's read marker up per row instead of joining the whole set.
--
-- The session list built has_unread with:
--
--     left join amux.session_read_markers srm
--       on srm.session_id = s.id and srm.actor_id = ca.actor_id
--
-- which the planner ran as a nested loop with a join filter rather than a probe
-- into session_read_markers_actor_session_idx — it materialised every read
-- marker the caller owns and rescanned them for each session on the page.
-- EXPLAIN showed `Rows Removed by Join Filter: 4948` on a 50-row page for an
-- actor with 101 markers: 50 x 101 comparisons to find 50 rows.
--
-- The cost is therefore O(page size x markers the caller owns), and markers only
-- accumulate — every session you open adds one. Measured on the live database
-- for the heaviest real actor (1,162 sessions, 101 markers), a 50-row page:
--
--     current (left join)          19.2 ms
--     correlated lookup             7.0 ms
--     ... and without participant_count, for reference   3.9 ms
--
-- So this is 63% of that query, and the share grows with how much of the
-- product a user has actually used. At 1,000 markers the join would be ~120 ms.
--
-- Equivalent because session_read_markers is unique on (actor_id, session_id):
-- the join could only ever match one row, and the subquery returns that same
-- row. Nothing else in the function changes.
--
-- Both SET clauses are repeated below on purpose. CREATE OR REPLACE FUNCTION
-- replaces the whole definition including its configuration, so omitting them
-- would silently drop search_path AND the plan_cache_mode set by
-- 20260810030000 — which is what keeps this function off its generic-plan
-- cliff (9.9s and a statement timeout at 120k sessions).
--
-- Idempotent: safe for the self-host apply-migrations loop to re-run.

CREATE OR REPLACE FUNCTION amux.list_current_actor_sessions(
  p_team_id uuid,
  p_limit integer DEFAULT 50,
  p_before_last_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_id uuid DEFAULT NULL::uuid,
  p_idea_id uuid DEFAULT NULL::uuid
) RETURNS TABLE(
  id uuid,
  title text,
  team_id uuid,
  mode text,
  idea_id uuid,
  last_message_at timestamp with time zone,
  last_message_preview text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  has_unread boolean,
  source text,
  cron_job_id text,
  summary text,
  primary_agent_id uuid,
  created_by_actor_id uuid,
  participant_count integer
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'app'
SET plan_cache_mode TO 'force_custom_plan'
AS $function$
begin
  -- Named-argument resolution ignores parameter order, so a stale caller that
  -- still passes p_team_id => null would bind to this function and get an empty
  -- page: `s.team_id = null` matches nothing. An empty session list is exactly
  -- the symptom this whole migration exists to remove, so refuse instead.
  -- (plpgsql only for that guard -- the query below is unchanged.)
  if p_team_id is null then
    raise exception 'list_current_actor_sessions requires p_team_id'
      using errcode = '22023';
  end if;

  return query
  with current_actor as (
    select amux.current_actor_id_for_team(p_team_id) as actor_id
  )
  select
    s.id,
    s.title,
    s.team_id,
    s.mode,
    s.idea_id,
    s.last_message_at,
    s.last_message_preview,
    s.created_at,
    s.updated_at,
    (
      s.last_message_at is not null
      and s.last_message_at > coalesce(
            (select srm.last_read_at
               from amux.session_read_markers srm
              where srm.session_id = s.id
                and srm.actor_id = ca.actor_id),
            '-infinity'::timestamptz)
    ) as has_unread,
    s.source,
    s.cron_job_id,
    s.summary,
    s.primary_agent_id,
    s.created_by_actor_id,
    (
      select count(*)
      from amux.session_participants participant
      where participant.session_id = s.id
    )::integer as participant_count
  from current_actor ca
  join amux.session_participants membership
    on membership.actor_id = ca.actor_id
  join amux.sessions s
    on s.id = membership.session_id
  where s.archived_at is null
    and s.team_id = p_team_id
    and (p_idea_id is null or s.idea_id = p_idea_id)
    and (
      p_before_id is null
      or (
        case
          when p_before_last_message_at is null then
            s.last_message_at is not null
            or (
              s.last_message_at is null
              and (
                s.created_at < p_before_created_at
                or (s.created_at = p_before_created_at and s.id < p_before_id)
              )
            )
          when s.last_message_at is null then false
          when s.last_message_at < p_before_last_message_at then true
          when s.last_message_at = p_before_last_message_at then
            s.created_at < p_before_created_at
            or (s.created_at = p_before_created_at and s.id < p_before_id)
          else false
        end
      )
    )
  order by
    s.last_message_at desc nulls first,
    s.created_at desc,
    s.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$function$;
