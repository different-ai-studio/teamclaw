-- detach_gateway_session: release a chat's binding so the next message opens a
-- fresh session.
--
-- `/clear` in a gateway chat used to only drop the agent runtime: the next
-- message re-spawned with no memory, but under the SAME session row, because
-- sessions are keyed by (team_id, binding) and that key is what ties a WeCom
-- conversation to its record. The reply said "Session cleared" while the
-- session, its history, and its place in the session list were all untouched.
--
-- Detaching the binding is what actually starts a new one: the old row keeps
-- every message it had and simply stops being the current session for that
-- chat, so `ensure_gateway_session` misses on the next inbound message and
-- creates a fresh row. Nothing is deleted.
--
-- The title gets the detach time appended, because the natural title of a
-- gateway session is derived from the chat itself ("WeCom DM: LiangLiang") and
-- would otherwise repeat identically for every generation of the conversation.
--
-- SECURITY DEFINER for the same reason as ensure_gateway_session: the daemon
-- calls this as its agent actor, which RLS does not let update the row.

create or replace function amux.detach_gateway_session(p_acp_session_id text)
returns table(session_id uuid, detached boolean)
language plpgsql
security definer
set search_path to 'amux', 'public', 'extensions'
as $function$
declare
  v_session uuid;
  v_binding text;
  v_title   text;
begin
  select s.id, s.binding, s.title
    into v_session, v_binding, v_title
    from amux.sessions as s
   where s.acp_session_id = p_acp_session_id;

  -- Unknown id, or a session that was never bound to a gateway chat: nothing
  -- to detach. Report it rather than raising — the caller treats this as "no
  -- new session needed" and falls back to just resetting the runtime.
  if v_session is null or v_binding is null then
    return query select v_session, false;
    return;
  end if;

  update amux.sessions
     set binding = null,
         title = case
                   when coalesce(v_title, '') = '' then v_title
                   else v_title || ' (' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ')'
                 end
   where id = v_session;

  return query select v_session, true;
end;
$function$;

grant execute on function amux.detach_gateway_session(text) to authenticated;
