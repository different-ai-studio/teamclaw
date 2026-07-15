-- 2026-05-27: SECURITY DEFINER RPC for the gateway-side "add participant"
-- path. The daemon-side gateway flow (WeCom/Discord/Feishu/Kook/WeChat/Email)
-- calls this after every inbound message to make sure the external sender is
-- recorded as a participant on the gateway session.
--
-- Previously the daemon did a plain PostgREST INSERT on
-- `session_participants`. That goes through the
-- `session_participants_insert_if_team_member` RLS check
-- (`202604230002_session_participants_creator_bootstrap_rls.sql`), which
-- requires the inserter's `app.current_actor_id()` to be either the session
-- creator or an existing participant. In normal operation the daemon's
-- primary-agent actor is both, but in practice we've seen 42501 RLS
-- failures here when the JWT's resolved actor doesn't line up with the
-- session's `primary_agent_id` (multi-actor user_id, team mismatch, etc.).
--
-- The gateway path is server-trusted (the channel-side auth already
-- happened). Replacing the REST INSERT with a SECURITY DEFINER RPC removes
-- the RLS edge case, with authorization re-asserted inside the function:
--   - caller's auth.uid() must own the session's primary_agent actor
--   - target actor must belong to the same team as the session
--
-- The function is idempotent (on conflict do nothing) and returns void.

create or replace function public.add_gateway_session_participant(
  p_session_id uuid,
  p_actor_id   uuid
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_primary_agent uuid;
  v_team          uuid;
begin
  select s.primary_agent_id, s.team_id
    into v_primary_agent, v_team
    from public.sessions as s
   where s.id = p_session_id;

  if v_primary_agent is null then
    raise exception 'add_gateway_session_participant: session % not found',
      p_session_id
      using errcode = 'P0002';
  end if;

  -- Authorization: the caller's JWT must own the session's primary-agent
  -- actor. This matches how the daemon authenticates (it spawns Supabase
  -- requests using the agent's user_id).
  if not exists (
    select 1
      from public.actors a
     where a.id = v_primary_agent
       and a.user_id = auth.uid()
  ) then
    raise exception
      'add_gateway_session_participant: caller is not the session primary agent'
      using errcode = '42501';
  end if;

  -- The target actor must be in the same team as the session. Mirrors the
  -- `enforce_session_participants_same_team` trigger (202604220002) so we
  -- fail fast with a clear error rather than tripping the trigger.
  if not exists (
    select 1
      from public.actors a
     where a.id = p_actor_id
       and a.team_id = v_team
  ) then
    raise exception
      'add_gateway_session_participant: actor % not in session team %',
      p_actor_id, v_team
      using errcode = '23514';
  end if;

  insert into public.session_participants (session_id, actor_id)
    values (p_session_id, p_actor_id)
  on conflict on constraint session_participants_session_id_actor_id_key
  do nothing;
end;
$$;

revoke all on function public.add_gateway_session_participant(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.add_gateway_session_participant(uuid, uuid)
  to authenticated;
