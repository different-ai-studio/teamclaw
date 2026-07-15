-- Agents (daemons) need SUB on their own amux/{team}/device/{actor}/rpc/res
-- because the daemon also acts as an RPC client (RpcClient::handle_response
-- in daemon/src/teamclaw/rpc.rs listens on this topic to receive responses
-- from RPC calls it makes to peer daemons). The hook's original ACL only
-- granted PUB on rpc/res (for serving requests), missing the symmetric SUB
-- needed when the daemon is the requester.
--
-- Symptom that led here (2026-05-08): after the JWT-embedded ACL went live,
-- daemon's SessionManager.subscribe_all() got SUBACK ReasonCode=128 on
-- device/{me}/rpc/res. Combined with rumqttc's reconnect path, this turned
-- into a self-takeover storm: every reconnect attempt produced multiple
-- short-lived sockets (~5-7 ms each) on the same clientid, each new socket
-- discarding the previous one via MQTT clientid takeover. EMQX
-- session.discarded climbed past 8000 in <2 hours.

create or replace function public.amux_acl_rules_for(
  p_team  uuid,
  p_actor uuid,
  p_type  text
) returns table (action text, topic text)
language sql
immutable
set search_path = public
as $$
  -- Member (iOS human): unchanged from 202604270002.
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

  -- Agent (daemon): adds SUB on its own rpc/res so RpcClient can receive
  -- responses to RPC calls this daemon initiates.
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
      ('sub', format('amux/%s/device/%s/rpc/res',           p_team, p_actor)),
      ('sub', format('amux/%s/device/%s/notify',            p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor))
    ) as r(action, topic)
   where p_type = 'agent';
$$;

revoke execute on function public.amux_acl_rules_for(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.amux_acl_rules_for(uuid, uuid, text) to supabase_auth_admin;
