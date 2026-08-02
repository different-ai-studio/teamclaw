-- Make `amux.list_current_actor_sessions` able to replace GET
-- /v1/teams/:teamId/sessions, which is being removed.
--
-- Background: the team endpoint fetched EVERY session in a team, then issued a
-- second PostgREST query filtering `session_participants` with
-- `.in("session_id", <all ids>)`. PostgREST puts `in.(...)` in the query
-- string, so past roughly 190-220 sessions that URL crossed the 8 KB request
-- line limit of the gateway in front of Supabase and came back as a bare
-- `URI too long` body — no PostgREST error code, no HTTP status — which the FC
-- error mapper could not classify and surfaced to clients as an opaque 500.
-- (Sentry BETLY-APP-Q, teamclaw-belayo-live-api.)
--
-- GET /v1/sessions is the paginated replacement, but it was missing three
-- things the team endpoint had:
--
--   1. No team filter. The RPC is actor-scoped across every team the caller
--      belongs to; callers that want one team's list had no way to say so.
--   2. No idea filter. Expo's listSessionsForIdea pulled the whole team list
--      and filtered client-side — which silently becomes wrong once the list
--      is paginated, since the matching rows may not be on the first page.
--   3. Fewer columns. summary / primary_agent_id / created_by_actor_id /
--      participant_count only existed on the team endpoint, so iOS had to call
--      BOTH (the team endpoint for those fields, then /v1/sessions purely to
--      recover has_unread, which the team endpoint hardcoded to false).
--
-- Adding all three here collapses those two round trips into one.
--
-- RETURNS TABLE is part of a function's signature, so CREATE OR REPLACE cannot
-- widen it — the function has to be dropped and recreated with its grants
-- re-applied (same dance as 20260727000000).
--
-- Note on visibility: this RPC keeps `amux.is_session_participant(s.id)` and
-- `archived_at is null`. The removed team endpoint instead relied on the
-- `sessions_select_if_participant_or_creator` RLS policy, which is slightly
-- wider (participant OR creator OR primary agent) and did NOT exclude archived
-- rows. In practice createSession upserts the creator into
-- session_participants, so the participant set already covers the creator; the
-- real change for iOS/Expo is that archived sessions stop appearing in the
-- list, which matches what desktop has always done.
--
-- Idempotent: both the old and the new signature are dropped up front so the
-- self-host apply-migrations loop can re-run this file safely.

DROP FUNCTION IF EXISTS amux.list_current_actor_sessions(
  integer, timestamp with time zone, timestamp with time zone, uuid
);
DROP FUNCTION IF EXISTS amux.list_current_actor_sessions(
  integer, timestamp with time zone, timestamp with time zone, uuid, uuid, uuid
);

CREATE FUNCTION amux.list_current_actor_sessions(
  p_limit integer DEFAULT 50,
  p_before_last_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_id uuid DEFAULT NULL::uuid,
  p_team_id uuid DEFAULT NULL::uuid,
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
LANGUAGE sql
STABLE
SET search_path TO 'public', 'app'
AS $function$
  with current_actor as (
    select amux.current_actor_id() as actor_id
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
      and s.last_message_at > coalesce(srm.last_read_at, '-infinity'::timestamptz)
    ) as has_unread,
    s.source,
    s.cron_job_id,
    s.summary,
    s.primary_agent_id,
    s.created_by_actor_id,
    -- Counted here rather than by a follow-up `.in(<all session ids>)` query:
    -- that pattern is exactly what blew past the gateway's URI limit. RLS on
    -- session_participants lets a participant see that session's participants,
    -- and every row reaching this point is one the caller participates in, so
    -- the count is complete.
    (
      select count(*)
      from amux.session_participants sp
      where sp.session_id = s.id
    )::integer as participant_count
  from amux.sessions s
  cross join current_actor ca
  left join amux.session_read_markers srm
    on srm.session_id = s.id
   and srm.actor_id = ca.actor_id
  where amux.is_session_participant(s.id)
    and s.archived_at is null
    and (p_team_id is null or s.team_id = p_team_id)
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
$function$;

REVOKE ALL ON FUNCTION amux.list_current_actor_sessions(
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid,
  p_team_id uuid,
  p_idea_id uuid
) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid,
  p_team_id uuid,
  p_idea_id uuid
) TO anon;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid,
  p_team_id uuid,
  p_idea_id uuid
) TO authenticated;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid,
  p_team_id uuid,
  p_idea_id uuid
) TO service_role;

-- Supporting index for the new team-scoped path. The existing list query was
-- actor-first (driven by is_session_participant); adding p_team_id makes
-- (team_id, last_message_at desc) the selective prefix for a single team's
-- list, which is what iOS and Expo now request on every session-list load.
CREATE INDEX IF NOT EXISTS sessions_team_last_message_idx
  ON amux.sessions (team_id, last_message_at DESC NULLS LAST)
  WHERE archived_at IS NULL;
