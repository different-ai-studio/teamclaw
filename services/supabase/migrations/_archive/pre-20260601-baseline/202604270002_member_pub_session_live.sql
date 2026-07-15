-- Members (iOS humans) need PUB on amux/{team}/session/+/live so user
-- messages reach the daemon's subscription. Without this, iOS sendMessage
-- gets a PUBACK from EMQX (per its default behavior on ACL-denied
-- publishes) but the broker silently drops the message before fanning
-- out to subscribers, so the daemon never sees second-and-later user
-- messages on a session.
--
-- Symptom that led here (2026-04-27): first user message in a fresh
-- collab session got an agent reply, every subsequent message hung
-- forever. The first message worked only because NewSessionSheet's
-- runtimeStartRpc path delivers the prompt as `initial_prompt` over
-- the RPC channel — completely bypassing session/live. As soon as iOS
-- relied on session/live for the next user message, the publish died
-- at the broker.

create or replace function public.amux_acl_rules_for(
  p_team  uuid,
  p_actor uuid,
  p_type  text
) returns table (action text, topic text)
language sql
immutable
set search_path = public
as $$
  -- Member (iOS human): team-wide read, team-wide command/RPC publish,
  -- plus PUB on session/live so outgoing user messages can reach the
  -- daemon and other team members subscribed to that session.
  select action, topic
    from (values
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/device/+/state',              p_team)),
      ('sub', format('amux/%s/device/+/runtime/+/state',    p_team)),
      ('sub', format('amux/%s/device/+/runtime/+/events',   p_team)),
      ('sub', format('amux/%s/device/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/device/+/rpc/req',            p_team)),
      ('pub', format('amux/%s/device/+/runtime/+/commands', p_team))
    ) as r(action, topic)
   where p_type = 'member'

  union all

  -- Agent (daemon): unchanged.
  select action, topic
    from (values
      ('pub', format('amux/%s/device/%s/state',             p_team, p_actor)),
      ('pub', format('amux/%s/device/%s/runtime/+/state',   p_team, p_actor)),
      ('pub', format('amux/%s/device/%s/runtime/+/events',  p_team, p_actor)),
      ('pub', format('amux/%s/device/%s/notify',            p_team, p_actor)),
      ('pub', format('amux/%s/device/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/user/+/notify',               p_team)),
      ('sub', format('amux/%s/device/%s/runtime/+/commands',p_team, p_actor)),
      ('sub', format('amux/%s/device/%s/rpc/req',           p_team, p_actor)),
      ('sub', format('amux/%s/device/%s/notify',            p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor))
    ) as r(action, topic)
   where p_type = 'agent';
$$;

revoke execute on function public.amux_acl_rules_for(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.amux_acl_rules_for(uuid, uuid, text) to supabase_auth_admin;
