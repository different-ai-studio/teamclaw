-- Make `sessions.source` actually reach the client, and repair the backfill.
--
-- 20260723000000 added amux.sessions.source / cron_job_id and wired the write
-- path (createCronSession inserts source='cron'), but the session-list READ
-- path never carried the value: `amux.list_current_actor_sessions` — the RPC
-- behind GET /v1/sessions — has a fixed RETURNS TABLE(...) signature that was
-- never updated, so `source` was silently dropped before it left the database.
-- The UI's cron filter (SessionListColumn `r.source === 'cron'`) therefore saw
-- null on every row and fell back to the device-local `cronSessionIds` overlay.
--
-- Two fixes here:
--
--   1. Recreate the RPC with source + cron_job_id in its result columns.
--      RETURNS TABLE is part of the signature, so CREATE OR REPLACE cannot
--      widen it — the function must be dropped and recreated, and its grants
--      re-applied (baseline.sql:7830-7833).
--   2. Redo the backfill. The 20260723 version keyed on
--      `binding LIKE 'cron/%'`, assuming scheduled sessions carried their
--      `cron/<job>/<run>` key in `sessions.binding`. They do not — `binding` is
--      NULL on every row ever written, so that UPDATE matched nothing and all
--      pre-existing cron sessions stayed at source='user'. The only surviving
--      signal on those legacy rows is the daemon-generated title, which is
--      always `Cron: <job name>` (apps/daemon/src/daemon/server/cron.rs:347).
--      cron_job_id is unrecoverable for them and stays NULL.
--
-- Idempotent so the self-host apply-migrations loop can re-run it.

-- 1. RPC: carry source + cron_job_id through to the list response.

DROP FUNCTION IF EXISTS amux.list_current_actor_sessions(
  integer, timestamp with time zone, timestamp with time zone, uuid
);

CREATE FUNCTION amux.list_current_actor_sessions(
  p_limit integer DEFAULT 50,
  p_before_last_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_id uuid DEFAULT NULL::uuid
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
  cron_job_id text
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
    s.cron_job_id
  from amux.sessions s
  cross join current_actor ca
  left join amux.session_read_markers srm
    on srm.session_id = s.id
   and srm.actor_id = ca.actor_id
  where amux.is_session_participant(s.id)
    and s.archived_at is null
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
  p_before_id uuid
) FROM PUBLIC;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid
) TO anon;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid
) TO authenticated;
GRANT ALL ON FUNCTION amux.list_current_actor_sessions(
  p_limit integer,
  p_before_last_message_at timestamp with time zone,
  p_before_created_at timestamp with time zone,
  p_before_id uuid
) TO service_role;

-- 2. Backfill legacy scheduled sessions the 20260723 binding-based UPDATE
--    missed. Title is the only origin signal left on those rows.

UPDATE amux.sessions
SET source = 'cron'
WHERE source = 'user'
  AND title LIKE 'Cron: %';
