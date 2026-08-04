-- Drive the session list from the current actor's participant rows instead of
-- scanning every session and evaluating is_session_participant() per row.
--
-- On teams with a large history this endpoint is the desktop's first request.
-- `limit` is applied only after visibility, unread state, participant counts,
-- and ordering are computed, so a 50-row page previously timed out for actors
-- participating in thousands of sessions.

CREATE INDEX IF NOT EXISTS session_participants_actor_session_idx
  ON amux.session_participants (actor_id, session_id);

CREATE OR REPLACE FUNCTION amux.list_current_actor_sessions(
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
  left join amux.session_read_markers srm
    on srm.session_id = s.id
   and srm.actor_id = ca.actor_id
  where s.archived_at is null
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
