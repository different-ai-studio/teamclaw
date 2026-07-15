-- 2026-05-16: gateway RPCs backing amuxd's AcpHandle + ChannelStore adapters.
--
-- Three pieces:
--   1. Persist amuxd's in-process ACP session id on `sessions.acp_session_id`
--      so the gateway can re-bind across daemon restarts.
--   2. RPC `ensure_gateway_session` — idempotent get-or-create of a session
--      for a (team_id, binding) pair, snapshotting participants on first
--      call.
--   3. RPC `upsert_external_actor` — idempotent UPSERT on the actors row
--      for an external IM user (Discord, WeCom, Feishu, Kook, WeChat,
--      Email) using the partial unique index added in migration
--      202605160001.
--   4. `messages.external_id` for idempotent gateway message ingestion.

-- ── sessions.acp_session_id ────────────────────────────────────────────────
alter table public.sessions
  add column acp_session_id text;

create unique index sessions_acp_session_id_uq
  on public.sessions (acp_session_id)
  where acp_session_id is not null;

-- ── messages.external_id ───────────────────────────────────────────────────
alter table public.messages
  add column external_id text;

create unique index messages_session_external_id_uq
  on public.messages (session_id, external_id)
  where external_id is not null;

-- ── RPC: upsert_external_actor ─────────────────────────────────────────────
-- Returns the actor's UUID. Updates `display_name` on every call so the
-- gateway can keep a fresh display string for the IM user.
create or replace function public.upsert_external_actor(
  p_team_id        uuid,
  p_source         text,
  p_source_id      text,
  p_display_name   text
)
returns uuid
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_actor uuid;
begin
  -- Try update first (cheap path: most calls are re-deliveries).
  update public.actors
     set display_name   = p_display_name,
         last_active_at = now(),
         updated_at     = now()
   where team_id   = p_team_id
     and source    = p_source
     and source_id = p_source_id
  returning id into v_actor;

  if v_actor is not null then
    return v_actor;
  end if;

  insert into public.actors
    (team_id, actor_type, source, source_id, display_name, last_active_at)
  values
    (p_team_id, 'external', p_source, p_source_id, p_display_name, now())
  returning id into v_actor;

  return v_actor;
exception when unique_violation then
  -- Race with a concurrent insert on the same (team_id, source, source_id).
  -- The other inserter won; pick up its row.
  select id into v_actor
    from public.actors
   where team_id   = p_team_id
     and source    = p_source
     and source_id = p_source_id;
  return v_actor;
end;
$$;

revoke all on function public.upsert_external_actor(uuid, text, text, text) from public;
grant execute on function public.upsert_external_actor(uuid, text, text, text) to authenticated;

-- ── RPC: ensure_gateway_session ────────────────────────────────────────────
-- Idempotent get-or-create. On first call inserts a new session keyed on
-- (team_id, binding), snapshots the participants, and mints an
-- `acp_session_id` placeholder. Subsequent calls return the existing row
-- unchanged.
create or replace function public.ensure_gateway_session(
  p_team_id                  uuid,
  p_binding                  text,
  p_title                    text,
  p_primary_agent_actor_id   uuid,
  p_owner_member_actor_ids   uuid[],
  p_participant_actor_ids    uuid[]
)
returns table (session_id uuid, acp_session_id text, created boolean)
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_session uuid;
  v_acp     text;
  v_created boolean := false;
begin
  select s.id, s.acp_session_id
    into v_session, v_acp
    from public.sessions s
   where s.team_id = p_team_id
     and s.binding = p_binding;

  if v_session is null then
    insert into public.sessions
      (team_id, idea_id, created_by_actor_id, primary_agent_id,
       mode, title, binding, acp_session_id)
    values
      (p_team_id,
       null,
       p_primary_agent_actor_id,
       p_primary_agent_actor_id,
       'collab',
       p_title,
       p_binding,
       encode(extensions.gen_random_bytes(16), 'hex'))
    returning id, sessions.acp_session_id
      into v_session, v_acp;
    v_created := true;

    insert into public.session_participants (session_id, actor_id)
      select v_session, x
        from unnest(
          array[p_primary_agent_actor_id]
            || coalesce(p_owner_member_actor_ids, '{}'::uuid[])
            || coalesce(p_participant_actor_ids,  '{}'::uuid[])
        ) as x
    on conflict (session_id, actor_id) do nothing;
  end if;

  session_id := v_session;
  acp_session_id := v_acp;
  created := v_created;
  return next;
end;
$$;

revoke all on function public.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) from public;
grant execute on function public.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) to authenticated;
