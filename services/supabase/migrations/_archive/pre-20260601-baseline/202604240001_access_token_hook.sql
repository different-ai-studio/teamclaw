-- Supabase Custom Access Token Hook: injects MQTT-ready claims into every JWT.
-- See docs/specs/2026-04-24-supabase-access-token-hook.md for the design.

-- --------------------------------------------------------------------------
-- Index: hook queries actors by user_id on every token issuance.
-- The existing actors_team_user_idx is composite (team_id, user_id) and
-- cannot efficiently serve user_id-only lookups.
-- --------------------------------------------------------------------------
create index if not exists idx_actors_user_id
  on public.actors (user_id)
  where user_id is not null;

-- --------------------------------------------------------------------------
-- Rule catalog. Pure function; edit this (in a new migration) to change the
-- ACL shape. Unknown actor_type returns zero rows.
-- --------------------------------------------------------------------------
create or replace function public.amux_acl_rules_for(
  p_team  uuid,
  p_actor uuid,
  p_type  text
) returns table (action text, topic text)
language sql
immutable
set search_path = public
as $$
  -- Member (iOS human): team-wide read, team-wide command/RPC publish.
  select action, topic
    from (values
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/device/+/state',              p_team)),
      ('sub', format('amux/%s/device/+/runtime/+/state',    p_team)),
      ('sub', format('amux/%s/device/+/runtime/+/events',   p_team)),
      ('sub', format('amux/%s/device/+/rpc/res',            p_team)),
      ('pub', format('amux/%s/device/+/rpc/req',            p_team)),
      ('pub', format('amux/%s/device/+/runtime/+/commands', p_team))
    ) as r(action, topic)
   where p_type = 'member'

  union all

  -- Agent (daemon): publish its own device-scoped state, subscribe its own
  -- inbox; pub rpc/res is scoped to its team (in-team RPC only).
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

-- --------------------------------------------------------------------------
-- Custom Access Token Hook. Supabase GoTrue calls this on every sign-in and
-- every refresh_token exchange. Contract:
--   input:  jsonb { "user_id": uuid|null, "claims": jsonb, ... }
--   output: jsonb { "claims": <merged claims> }  -- OR the untouched event
--                                                   when there is nothing to do.
-- This function MUST NOT raise on realistic input; a hook error causes every
-- auth call to fail with HTTP 500. All edge cases return sane defaults.
-- --------------------------------------------------------------------------
create or replace function public.amux_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_user_id     uuid;
  v_claims      jsonb;
  v_memberships jsonb;
  v_acl         jsonb;
begin
  v_user_id := nullif(event->>'user_id','')::uuid;

  if v_user_id is null then
    return event;
  end if;

  v_claims := coalesce(event->'claims', '{}'::jsonb);

  -- Memberships: one row per actor this user owns.
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'team_id',    a.team_id::text,
      'actor_id',   a.id::text,
      'actor_type', a.actor_type
    ) order by a.team_id, a.id),
    '[]'::jsonb
  )
    into v_memberships
    from public.actors a
   where a.user_id = v_user_id;

  -- ACL: flatten every actor's rule set, terminate with a deny-all.
  with expanded as (
    select jsonb_build_object(
             'permission', 'allow',
             'action',     r.action,
             'topic',      r.topic
           ) as rule
      from public.actors a,
           lateral public.amux_acl_rules_for(a.team_id, a.id, a.actor_type) r
     where a.user_id = v_user_id
  )
  select coalesce(jsonb_agg(rule), '[]'::jsonb)
           || jsonb_build_array(jsonb_build_object(
                'permission','deny','action','all','topic','#'
              ))
    into v_acl
    from expanded;

  -- Merge. Preserve existing claims; acl at top level; memberships under
  -- app_metadata (merged with whatever GoTrue already put there).
  v_claims := v_claims
    || jsonb_build_object('acl', v_acl)
    || jsonb_build_object(
         'app_metadata',
         coalesce(v_claims->'app_metadata', '{}'::jsonb)
           || jsonb_build_object('memberships', v_memberships)
       );

  return jsonb_build_object('claims', v_claims);
exception
  when others then
    return event;
end;
$$;

-- --------------------------------------------------------------------------
-- Permissions. supabase_auth_admin is the role GoTrue uses to call hooks.
-- --------------------------------------------------------------------------
revoke execute on function public.amux_access_token_hook(jsonb)         from public;
revoke execute on function public.amux_acl_rules_for(uuid, uuid, text)  from public;

grant  execute on function public.amux_access_token_hook(jsonb)         to supabase_auth_admin;
grant  execute on function public.amux_acl_rules_for(uuid, uuid, text)  to supabase_auth_admin;
