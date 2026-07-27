-- Let a gateway chat list its own past sessions and switch back into one.
--
-- `/new` (previously `/clear`) detaches the chat's binding so the next message
-- opens a fresh session; the old row keeps every message it had. Until now that
-- was a one-way door: nothing could name those old sessions, let alone re-enter
-- one. `/sessions` listed the daemon's in-memory logical→ACP map, which holds at
-- most the currently-live session, so the reply was a single bare hex id — and
-- right after `/new` it was "No sessions." while the history sat in the database.
--
-- Two pieces are missing to make the round trip work:
--
--   1. A durable marker of WHICH chat a session belonged to. `binding` cannot
--      serve: it is the "currently attached" pointer and `detach` nulls it, so a
--      detached session has no trace of its origin. This adds `gateway_key`,
--      written at create time from the binding and never cleared, so the whole
--      lineage of one WeCom conversation stays enumerable.
--
--   2. An attach operation — the inverse of detach. Because sessions are keyed
--      by (team_id, binding) with a unique constraint, attaching means moving
--      the binding: release it from whoever holds it, then point it at the
--      target. Both happen in one function call, so the unique constraint is
--      never transiently violated.
--
-- Backfill note: `gateway_key` can only be recovered for sessions that are
-- still attached (binding is not null). Sessions detached by a `/clear` before
-- this migration lost their origin and stay unlisted — there is no signal left
-- on the row to recover it from. New detaches keep working from here on.

-- ── 1. gateway_key: the chat a session belongs to, for its whole lifetime ────

ALTER TABLE amux.sessions
  ADD COLUMN IF NOT EXISTS gateway_key text;

CREATE INDEX IF NOT EXISTS sessions_gateway_key_idx
  ON amux.sessions (team_id, gateway_key)
  WHERE gateway_key IS NOT NULL;

UPDATE amux.sessions
   SET gateway_key = binding
 WHERE gateway_key IS NULL
   AND binding IS NOT NULL;

-- ── 2. ensure_gateway_session: stamp gateway_key (and repair older rows) ─────
--
-- Unchanged from 20260727020000 except for the gateway_key writes: the insert
-- stamps it, and existing rows get it backfilled on their next message so a
-- session created before this migration becomes listable without a data
-- migration of its own.

create or replace function amux.ensure_gateway_session(
  p_team_id uuid,
  p_binding text,
  p_title text,
  p_primary_agent_actor_id uuid,
  p_owner_member_actor_ids uuid[],
  p_participant_actor_ids uuid[]
)
returns table(session_id uuid, acp_session_id text, created boolean)
language plpgsql
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
declare
  v_session uuid;
  v_acp     text;
  v_created boolean := false;
begin
  select s.id, s.acp_session_id
    into v_session, v_acp
    from amux.sessions as s
   where s.team_id = p_team_id
     and s.binding = p_binding;

  if v_session is null then
    insert into amux.sessions
      (team_id, idea_id, created_by_actor_id, primary_agent_id,
       mode, title, binding, gateway_key, acp_session_id)
    values
      (p_team_id,
       null,
       p_primary_agent_actor_id,
       p_primary_agent_actor_id,
       'collab',
       p_title,
       p_binding,
       p_binding,
       encode(extensions.gen_random_bytes(16), 'hex'))
    returning amux.sessions.id, amux.sessions.acp_session_id
      into v_session, v_acp;
    v_created := true;
  else
    -- Un-archive on inbound traffic (see 20260727020000), and backfill
    -- gateway_key for rows that predate this migration. `source` is left
    -- alone: gateway rows created here have always carried the default
    -- 'user', and the cron path reaches this same function with a
    -- `cron/<job>/<run>` binding, so there is no single correct value to
    -- rewrite them to from in here.
    update amux.sessions
       set archived_at = null,
           gateway_key = coalesce(gateway_key, p_binding)
     where id = v_session
       and (archived_at is not null or gateway_key is null);
  end if;

  -- Runs for existing rows too: this is what makes a session that outlived
  -- the agent which created it reachable again.
  insert into amux.session_participants (session_id, actor_id)
    select v_session, participant_actor_id
      from unnest(
        array[p_primary_agent_actor_id]
          || coalesce(p_owner_member_actor_ids, '{}'::uuid[])
          || coalesce(p_participant_actor_ids,  '{}'::uuid[])
      ) as participant_actor_id
     where participant_actor_id is not null
  on conflict on constraint session_participants_session_id_actor_id_key
  do nothing;

  return query select v_session, v_acp, v_created;
end;
$function$;

-- ── 3. list_gateway_sessions: this chat's own sessions, newest first ─────────
--
-- Scoped to one gateway_key, so a WeCom conversation only ever sees its own
-- lineage — not other chats', and not the desktop's. Archived rows are included
-- deliberately: archiving hides a chat from the session list, but from inside
-- the chat itself the conversation is still part of its own history, and
-- attaching to one un-archives it anyway.
--
-- SECURITY DEFINER for the same reason as the two functions above: the daemon
-- calls this as its agent actor, whose RLS grants do not cover a detached row
-- (`is_session_participant` still holds, but the row is not reachable through
-- the session-list RPC once unbound).

create or replace function amux.list_gateway_sessions(
  p_team_id uuid,
  p_gateway_key text,
  p_limit integer default 20
)
returns table(
  session_id uuid,
  acp_session_id text,
  title text,
  is_current boolean,
  last_message_at timestamp with time zone,
  created_at timestamp with time zone
)
language sql
stable
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
  select s.id,
         s.acp_session_id,
         s.title,
         (s.binding is not null and s.binding = p_gateway_key) as is_current,
         s.last_message_at,
         s.created_at
    from amux.sessions as s
   where s.team_id = p_team_id
     and s.gateway_key = p_gateway_key
   order by coalesce(s.last_message_at, s.created_at) desc, s.id desc
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$function$;

grant execute on function amux.list_gateway_sessions(uuid, text, integer) to authenticated;

-- ── 4. attach_gateway_session: the inverse of detach ────────────────────────
--
-- Moves a chat's binding onto an existing session of that same chat, so the
-- next inbound message resolves to it and the conversation continues there.
--
-- Guards:
--   * the target must belong to the same chat (`gateway_key = p_binding`) —
--     otherwise a chat could hijack another conversation's session, which the
--     daemon's agent actor has no business doing;
--   * whoever currently holds the binding is detached first, with the same
--     title timestamp suffix `detach_gateway_session` applies, so the two
--     paths produce identically-shaped history;
--   * attaching un-archives, because the chat is demonstrably in use.
--
-- Returns attached=false (with a null session) when the target does not exist
-- or is not part of this chat's lineage, so the caller can say so rather than
-- reporting a switch that did not happen.

create or replace function amux.attach_gateway_session(
  p_binding text,
  p_session_id uuid
)
returns table(session_id uuid, acp_session_id text, attached boolean)
language plpgsql
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
declare
  v_team    uuid;
  v_acp     text;
  v_binding text;
  v_holder  uuid;
  v_title   text;
begin
  select s.team_id, s.acp_session_id, s.binding
    into v_team, v_acp, v_binding
    from amux.sessions as s
   where s.id = p_session_id
     and s.gateway_key = p_binding;

  if v_team is null then
    return query select null::uuid, null::text, false;
    return;
  end if;

  -- Already the current session for this chat: nothing to move, and reporting
  -- it as attached keeps the command idempotent.
  if v_binding is not null and v_binding = p_binding then
    update amux.sessions set archived_at = null where id = p_session_id;
    return query select p_session_id, v_acp, true;
    return;
  end if;

  select s.id, s.title
    into v_holder, v_title
    from amux.sessions as s
   where s.team_id = v_team
     and s.binding = p_binding;

  if v_holder is not null then
    update amux.sessions
       set binding = null,
           title = case
                     when coalesce(v_title, '') = '' then v_title
                     else v_title || ' (' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ')'
                   end
     where id = v_holder;
  end if;

  update amux.sessions
     set binding = p_binding,
         archived_at = null
   where id = p_session_id;

  return query select p_session_id, v_acp, true;
end;
$function$;

grant execute on function amux.attach_gateway_session(text, uuid) to authenticated;
