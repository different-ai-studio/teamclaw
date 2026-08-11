-- list_session_push_targets: fall back to "Someone" when the sender actor row
-- is gone, not just when its display_name is null.
--
-- The inner coalesce only fires for a row that exists with a null name. When
-- the actor row itself is missing (deleted actor, or a message whose sender is
-- no longer a participant), the `sender` CTE yields zero rows and
-- `(select display_name from sender)` returns NULL, so the payload carries
-- "sender_display_name": null.
--
-- FC's other implementation of this same contract already returns "Someone"
-- for that case (services/fc/src/lib/pg-repo/push-targets.ts: `senderRows[0]
-- ?.displayName ?? "Someone"`), so the two backends disagreed on identical
-- input. push-dispatch.ts papers over it with `|| 'Someone'` at the call site;
-- this makes the RPC itself hold the contract that 016_push_notifications.sql
-- asserts.

create or replace function amux.list_session_push_targets(p_session_id uuid, p_exclude_actor_id uuid)
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
  with sender as (
    select coalesce(display_name, 'Someone') as display_name
      from amux.actors where id = p_exclude_actor_id
  ),
  recipients as (
    select
      a.user_id,
      coalesce(
        (select jsonb_agg(jsonb_build_object(
            'provider', dpt.provider,
            'token',    dpt.token,
            'device_id', dpt.device_id))
           from amux.device_push_tokens dpt
          where dpt.user_id = a.user_id
            and dpt.revoked_at is null),
        '[]'::jsonb
      ) as tokens,
      coalesce(
        (select to_jsonb(np)
           from amux.notification_prefs np
          where np.user_id = a.user_id),
        jsonb_build_object('enabled', true)
      ) as prefs,
      coalesce(
        (select jsonb_agg(jsonb_build_object(
            'device_id',        cp.device_id,
            'foreground_until', cp.foreground_until))
           from amux.client_presence cp
          where cp.user_id = a.user_id
            and cp.foreground_until > now()),
        '[]'::jsonb
      ) as presence,
      exists(
        select 1 from amux.session_mutes sm
         where sm.user_id = a.user_id
           and sm.session_id = p_session_id
      ) as muted
    from amux.session_participants sp
    join amux.actors a on a.id = sp.actor_id
    where sp.session_id = p_session_id
      and sp.actor_id <> p_exclude_actor_id
      and a.user_id is not null
      and a.actor_type = 'member'
  )
  select jsonb_build_object(
    'sender_display_name', coalesce((select display_name from sender), 'Someone'),
    'recipients', coalesce(
       (select jsonb_agg(to_jsonb(r)) from recipients r),
       '[]'::jsonb)
  );
$function$;
