create table if not exists public.session_read_markers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  actor_id uuid not null references public.actors(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  last_read_message_id uuid null references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, actor_id)
);

alter table public.session_read_markers enable row level security;

create unique index if not exists session_read_markers_actor_session_idx
on public.session_read_markers(actor_id, session_id);

create index if not exists session_read_markers_session_actor_idx
on public.session_read_markers(session_id, actor_id);

create index if not exists messages_session_created_idx
on public.messages(session_id, created_at desc);

create index if not exists sessions_team_last_message_idx
on public.sessions(team_id, last_message_at desc nulls first, created_at desc);

drop trigger if exists set_session_read_markers_updated_at on public.session_read_markers;
create trigger set_session_read_markers_updated_at before update on public.session_read_markers
for each row execute function app.bump_updated_at();

drop policy if exists session_read_markers_select_own on public.session_read_markers;
create policy session_read_markers_select_own on public.session_read_markers
for select to authenticated using (
  actor_id = app.current_actor_id()
  and app.is_session_participant(session_id)
);

drop policy if exists session_read_markers_insert_own on public.session_read_markers;
create policy session_read_markers_insert_own on public.session_read_markers
for insert to authenticated with check (
  actor_id = app.current_actor_id()
  and app.is_session_participant(session_id)
);

drop policy if exists session_read_markers_update_own on public.session_read_markers;
create policy session_read_markers_update_own on public.session_read_markers
for update to authenticated using (
  actor_id = app.current_actor_id()
  and app.is_session_participant(session_id)
) with check (
  actor_id = app.current_actor_id()
  and app.is_session_participant(session_id)
);

create or replace function public.list_current_actor_sessions(
  p_limit integer default 50,
  p_before_last_message_at timestamptz default null
)
returns table (
  id uuid,
  title text,
  team_id uuid,
  mode text,
  idea_id uuid,
  last_message_at timestamptz,
  last_message_preview text,
  created_at timestamptz,
  updated_at timestamptz,
  has_unread boolean
)
language sql
stable
security invoker
set search_path = public, app
as $$
  select
    s.id,
    s.title,
    s.team_id,
    s.mode,
    s.idea_id,
    s.last_message_at,
    s.last_message_preview,
    s.created_at,
    s.updated_at,
    (
      s.last_message_at is not null
      and s.last_message_at > coalesce(srm.last_read_at, '-infinity'::timestamptz)
    ) as has_unread
  from public.sessions s
  left join public.session_read_markers srm
    on srm.session_id = s.id
   and srm.actor_id = app.current_actor_id()
  where app.is_session_participant(s.id)
    and (
      p_before_last_message_at is null
      or s.last_message_at < p_before_last_message_at
    )
  order by s.last_message_at desc nulls first, s.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

create or replace function public.mark_current_actor_session_viewed(
  p_session_id uuid,
  p_last_read_message_id uuid default null
)
returns void
language plpgsql
security invoker
set search_path = public, app
as $$
declare
  v_actor_id uuid := app.current_actor_id();
begin
  if v_actor_id is null then
    raise exception 'no current actor' using errcode = '42501';
  end if;

  if not app.is_session_participant(p_session_id) then
    raise exception 'not a session participant' using errcode = '42501';
  end if;

  insert into public.session_read_markers (
    session_id,
    actor_id,
    last_read_at,
    last_read_message_id
  )
  values (
    p_session_id,
    v_actor_id,
    now(),
    p_last_read_message_id
  )
  on conflict (session_id, actor_id)
  do update set
    last_read_at = excluded.last_read_at,
    last_read_message_id = excluded.last_read_message_id;
end;
$$;

revoke all on function public.list_current_actor_sessions(integer, timestamptz) from public;
revoke all on function public.mark_current_actor_session_viewed(uuid, uuid) from public;
grant execute on function public.list_current_actor_sessions(integer, timestamptz) to authenticated;
grant execute on function public.mark_current_actor_session_viewed(uuid, uuid) to authenticated;
