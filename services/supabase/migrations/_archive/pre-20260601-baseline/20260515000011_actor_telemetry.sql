-- actor_message_feedback + actor_session_report
-- Replaces the libSQL telemetry.db tables that used to live at
-- ~/.teamclaw/telemetry.db.

create table public.actor_message_feedback (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references public.actors(id)   on delete cascade,
  team_id      uuid not null references public.teams(id)    on delete cascade,
  session_id   uuid references public.sessions(id)          on delete set null,
  message_id   uuid,
  kind         text not null check (kind in ('positive','negative')),
  star_rating  smallint check (star_rating between 1 and 5),
  skill        text,
  created_at   timestamptz not null default now()
);

create index actor_message_feedback_team_idx
  on public.actor_message_feedback (team_id, created_at desc);
create index actor_message_feedback_actor_idx
  on public.actor_message_feedback (actor_id, created_at desc);

alter table public.actor_message_feedback enable row level security;

create policy actor_message_feedback_select_if_team_member
  on public.actor_message_feedback
  for select to authenticated
  using (app.is_team_member(team_id));

create policy actor_message_feedback_insert_self
  on public.actor_message_feedback
  for insert to authenticated
  with check (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  );

grant select, insert on public.actor_message_feedback to authenticated;

create table public.actor_session_report (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references public.actors(id)  on delete cascade,
  team_id      uuid not null references public.teams(id)   on delete cascade,
  session_id   uuid references public.sessions(id)         on delete set null,
  tokens_used  bigint   not null default 0,
  cost_usd     numeric(12,4) not null default 0,
  model        text,
  agent_kind   text,
  created_at   timestamptz not null default now(),
  ended_at     timestamptz
);

create index actor_session_report_team_idx
  on public.actor_session_report (team_id, created_at desc);
create index actor_session_report_actor_idx
  on public.actor_session_report (actor_id, created_at desc);

alter table public.actor_session_report enable row level security;

create policy actor_session_report_select_if_team_member
  on public.actor_session_report
  for select to authenticated
  using (app.is_team_member(team_id));

create policy actor_session_report_insert_self
  on public.actor_session_report
  for insert to authenticated
  with check (
    app.is_team_member(team_id)
    and exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
         and a.team_id = team_id
    )
  );

grant select, insert on public.actor_session_report to authenticated;
