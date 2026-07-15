-- Members (iOS humans) need SUB on amux/{team}/device/+/notify so the
-- iOS TeamclawService.resyncDaemonSubscriptions() path can receive
-- `Notify` events from any daemon in the team (e.g. membership.refresh
-- hints). The original member ACL granted only `sub user/{self}/notify`,
-- so iOS's per-daemon `subscribe(deviceNotify(teamID, deviceID))` call
-- got SUBACK in MQTT 3.1.1 but was silently dropped server-side, and the
-- subscription never landed in EMQX's session state. Membership refresh
-- hints from the daemon therefore never reached iOS.
--
-- Symptom that led here (2026-05-12): EMQX trace on the iOS client
-- showed `authorization_matched_deny` for SUBSCRIBE on
-- `amux/<team>/device/<daemon>/notify`, with action=SUBSCRIBE(Q1)
-- source=jwt. The client kept reconnecting and re-attempting, but the
-- broker never accepted the sub, so notify-driven flows on the iOS
-- side stayed dark.

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
  -- plus SUB on device/+/notify so iOS receives daemon-emitted Notify
  -- events for every daemon in the team.
  select action, topic
    from (values
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/device/+/state',              p_team)),
      ('sub', format('amux/%s/device/+/notify',             p_team)),
      ('sub', format('amux/%s/device/+/runtime/+/state',    p_team)),
      ('sub', format('amux/%s/device/+/runtime/+/events',   p_team)),
      ('sub', format('amux/%s/device/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/device/+/rpc/req',            p_team)),
      ('pub', format('amux/%s/device/+/runtime/+/commands', p_team))
    ) as r(action, topic)
   where p_type = 'member'

  union all

  -- Agent (daemon): unchanged from 202605080002.
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
