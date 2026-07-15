-- 2026-05-17: push notifications foundation
-- Five tables + RLS for: device tokens, global prefs, per-session mute,
-- foreground presence heartbeat, dispatch idempotency.

create table public.device_push_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_id    text not null,
  platform     text not null check (platform in ('ios','android','desktop')),
  provider     text not null check (provider in ('apns','jpush','tauri')),
  token        text not null,
  app_version  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  unique (user_id, device_id, provider)
);
create index if not exists device_push_tokens_user_active_idx
  on public.device_push_tokens (user_id) where revoked_at is null;

create table public.notification_prefs (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  enabled       boolean not null default true,
  dnd_start_min smallint check (dnd_start_min between 0 and 1439),
  dnd_end_min   smallint check (dnd_end_min between 0 and 1439),
  dnd_tz        text not null default 'Asia/Shanghai',
  updated_at    timestamptz not null default now()
);

create table public.session_mutes (
  user_id    uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  muted_at   timestamptz not null default now(),
  primary key (user_id, session_id)
);

create table public.client_presence (
  user_id          uuid not null references auth.users(id) on delete cascade,
  device_id        text not null,
  foreground_until timestamptz not null,
  primary key (user_id, device_id)
);

create table public.push_idempotency (
  message_id uuid primary key references public.messages(id) on delete cascade,
  claimed_at timestamptz not null default now()
);
create index if not exists push_idempotency_claimed_at_idx
  on public.push_idempotency(claimed_at);

-- RLS: every table is owner-only for authenticated reads/writes.
-- FC uses service-role key which bypasses RLS.

alter table public.device_push_tokens enable row level security;
create policy device_push_tokens_owner on public.device_push_tokens
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.notification_prefs enable row level security;
create policy notification_prefs_owner on public.notification_prefs
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.session_mutes enable row level security;
create policy session_mutes_owner on public.session_mutes
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.client_presence enable row level security;
create policy client_presence_owner on public.client_presence
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.push_idempotency enable row level security;
-- No authenticated policy: only service-role FC may touch this table.

-- Returns a single jsonb object:
--   { sender_display_name: text,
--     recipients: [{ user_id, tokens, prefs, presence, muted }, ...] }
create or replace function public.list_session_push_targets(
  p_session_id uuid,
  p_exclude_actor_id uuid
) returns jsonb
  language sql security definer
  set search_path = public
as $$
  with sender as (
    select coalesce(display_name, 'Someone') as display_name
      from public.actors where id = p_exclude_actor_id
  ),
  recipients as (
    select
      a.user_id,
      coalesce(
        (select jsonb_agg(jsonb_build_object(
            'provider', dpt.provider,
            'token',    dpt.token,
            'device_id', dpt.device_id))
           from public.device_push_tokens dpt
          where dpt.user_id = a.user_id
            and dpt.revoked_at is null),
        '[]'::jsonb
      ) as tokens,
      coalesce(
        (select to_jsonb(np)
           from public.notification_prefs np
          where np.user_id = a.user_id),
        jsonb_build_object('enabled', true)
      ) as prefs,
      coalesce(
        (select jsonb_agg(jsonb_build_object(
            'device_id',        cp.device_id,
            'foreground_until', cp.foreground_until))
           from public.client_presence cp
          where cp.user_id = a.user_id
            and cp.foreground_until > now()),
        '[]'::jsonb
      ) as presence,
      exists(
        select 1 from public.session_mutes sm
         where sm.user_id = a.user_id
           and sm.session_id = p_session_id
      ) as muted
    from public.session_participants sp
    join public.actors a on a.id = sp.actor_id
    where sp.session_id = p_session_id
      and sp.actor_id <> p_exclude_actor_id
      and a.user_id is not null
      and a.actor_type = 'member'
  )
  select jsonb_build_object(
    'sender_display_name', (select display_name from sender),
    'recipients', coalesce(
       (select jsonb_agg(to_jsonb(r)) from recipients r),
       '[]'::jsonb)
  );
$$;

revoke all on function public.list_session_push_targets(uuid, uuid) from public, anon, authenticated;
-- Only service-role may call (FC uses service-role).

create or replace function public.push_idempotency_claim(p_message_id uuid)
returns table(claimed boolean)
  language plpgsql security definer
  set search_path = public
as $$
begin
  insert into public.push_idempotency(message_id) values (p_message_id)
  on conflict do nothing;
  return query select found;
end;
$$;

revoke all on function public.push_idempotency_claim(uuid) from public, anon, authenticated;
