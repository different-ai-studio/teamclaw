-- ensure_gateway_session: keep the participant set current on every call,
-- not just when the session row is first created.
--
-- The session is keyed by (team_id, binding), so a WeCom chat maps to one row
-- forever. Participants were only written inside the `if v_session is null`
-- branch, which made the very first call decide the membership permanently.
-- Anything that changes afterwards never lands:
--
--   * the daemon re-registers and gets a NEW agent actor id (re-onboarding,
--     reinstall) — the session then lists an agent that no longer runs, and
--     the live one cannot see its own chat;
--   * an admin owner is granted access to the agent later — they never get
--     added, so the chat stays invisible in their session list;
--   * a new external participant joins the conversation.
--
-- Both symptoms are the same bug from the user's side: WeCom sends and
-- receives fine (messages are written on a different path) while the session
-- is missing from the desktop list, which filters purely on
-- `is_session_participant`.
--
-- The daemon does try to repair this per message via
-- `POST /v1/sessions/:id/participants`, but that path runs as the caller and
-- the RLS policy requires being the session's creator or already a
-- participant — precisely what is false here, so it fails with
-- "new row violates row-level security policy" on every single message.
-- This function is SECURITY DEFINER, so doing the upsert here works.
--
-- Idempotent: ON CONFLICT DO NOTHING, and the daemon already passes the full
-- intended set (primary agent + admin owners + external senders) on each call.

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
    returning amux.sessions.id, amux.sessions.acp_session_id
      into v_session, v_acp;
    v_created := true;
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
