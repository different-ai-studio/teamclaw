create table public.daemon_invites (
  id uuid primary key default gen_random_uuid(),
  invite_token uuid not null unique default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  created_by_member_id uuid not null references public.members(id) on delete restrict,
  expires_at timestamptz not null,
  claimed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_daemon_invites_team_id on public.daemon_invites(team_id);
create index idx_daemon_invites_agent_id on public.daemon_invites(agent_id);
create index idx_daemon_invites_expires_at on public.daemon_invites(expires_at)
  where claimed_at is null;

create trigger set_daemon_invites_updated_at before update on public.daemon_invites
  for each row execute function app.bump_updated_at();

alter table public.daemon_invites enable row level security;

create policy daemon_invites_select_for_team_members on public.daemon_invites
  for select using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = daemon_invites.team_id
        and tm.member_id = app.current_member_id()
    )
  );
