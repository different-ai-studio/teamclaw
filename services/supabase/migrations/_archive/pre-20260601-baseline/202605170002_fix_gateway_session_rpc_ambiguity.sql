-- 2026-05-17: avoid PL/pgSQL output-column ambiguity in gateway session RPC.
--
-- `returns table (session_id ...)` exposes `session_id` as a PL/pgSQL
-- variable. An unqualified conflict target like `(session_id, actor_id)` can
-- therefore be parsed ambiguously inside the function body. Keep the public
-- return shape stable, but avoid bare column references in the body.

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
    from public.sessions as s
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
    returning public.sessions.id, public.sessions.acp_session_id
      into v_session, v_acp;
    v_created := true;

    insert into public.session_participants (session_id, actor_id)
      select v_session, participant_actor_id
        from unnest(
          array[p_primary_agent_actor_id]
            || coalesce(p_owner_member_actor_ids, '{}'::uuid[])
            || coalesce(p_participant_actor_ids,  '{}'::uuid[])
        ) as participant_actor_id
    on conflict on constraint session_participants_session_id_actor_id_key
    do nothing;
  end if;

  return query select v_session, v_acp, v_created;
end;
$$;

revoke all on function public.upsert_external_actor(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.upsert_external_actor(uuid, text, text, text) to authenticated;

revoke all on function public.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.ensure_gateway_session(uuid, text, text, uuid, uuid[], uuid[]) to authenticated;
