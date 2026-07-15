-- Upgrade `list_current_actor_sessions` to keyset pagination + session archive.
--
-- 202605170001 deployed the v1 shape (single-cursor, 3-col index, no archive).
-- The v2 frontend (single source of truth) calls the RPC with the keyset
-- triple (last_message_at, created_at, id) and renders archived sessions
-- separately, so the deployed function/index need to be replaced in lock-step
-- with the column add.

alter table public.sessions
  add column if not exists archived_at timestamptz null;

drop index if exists sessions_team_last_message_idx;

create index if not exists sessions_team_last_message_idx
  on public.sessions (team_id, last_message_at desc nulls first, created_at desc, id desc);

create index if not exists sessions_team_active_last_message_idx
  on public.sessions (team_id, last_message_at desc nulls first, created_at desc, id desc)
  where archived_at is null;

drop function if exists public.list_current_actor_sessions(integer, timestamptz);

create or replace function public.list_current_actor_sessions(
  p_limit integer default 50,
  p_before_last_message_at timestamptz default null,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  id uuid,
  title text,
  team_id uuid,
  mode text,
  idea_id uuid,
  last_message_at timestamptz,
  last_message_preview text,
  created_at timestamptz,
  updated_at timestamptz,
  has_unread boolean
)
language sql
stable
security invoker
set search_path = public, app
as $$
  with current_actor as (
    select app.current_actor_id() as actor_id
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
    ) as has_unread
  from public.sessions s
  cross join current_actor ca
  left join public.session_read_markers srm
    on srm.session_id = s.id
   and srm.actor_id = ca.actor_id
  where app.is_session_participant(s.id)
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
$$;

revoke all on function public.list_current_actor_sessions(integer, timestamptz, timestamptz, uuid) from public;
grant execute on function public.list_current_actor_sessions(integer, timestamptz, timestamptz, uuid) to authenticated;
