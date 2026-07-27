-- ensure_gateway_session: bring an archived chat back when it speaks again.
--
-- Archiving is a "I am done with this conversation" signal, but a gateway
-- session is not something the user opens and closes — it is a WeCom chat that
-- keeps existing. The session row is keyed by (team_id, binding), so once
-- archived it stays archived while messages keep flowing into it: the chat
-- sends and receives normally and is simply absent from every session list,
-- which filters on `archived_at is null`. From the user's side the bot works
-- but the conversation cannot be found anywhere.
--
-- Un-archiving on inbound traffic resolves that contradiction in the only
-- direction that loses nothing: archive still hides the chat, and it stays
-- hidden until someone actually writes in it again.
--
-- This runs on the inbound path only (the daemon calls this function when a
-- message arrives), so an agent's own reply cannot resurrect a chat by itself.

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
  else
    -- A new message on an archived chat un-archives it.
    update amux.sessions
       set archived_at = null
     where id = v_session
       and archived_at is not null;
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
