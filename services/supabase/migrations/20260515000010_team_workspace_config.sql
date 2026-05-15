-- team_workspace_config: 1:1 with teams, holds desktop workspace metadata
-- that used to live in .teamclaw/teamclaw.json.

create table public.team_workspace_config (
  team_id              uuid primary key references public.teams(id) on delete cascade,
  git_url              text,
  git_branch           text,
  -- Team-shared bot PAT. Stored plaintext for v2; encryption (e.g. pgsodium
  -- vault.secrets) is a follow-up. RLS limits read to team members.
  git_token            text,
  ai_gateway_endpoint  text,
  enabled              boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger set_team_workspace_config_updated_at
  before update on public.team_workspace_config
  for each row execute function app.bump_updated_at();

alter table public.team_workspace_config enable row level security;

create policy team_workspace_config_select_if_team_member
  on public.team_workspace_config
  for select to authenticated
  using (app.is_team_member(team_id));

create policy team_workspace_config_insert_if_team_member
  on public.team_workspace_config
  for insert to authenticated
  with check (app.is_team_member(team_id));

create policy team_workspace_config_update_if_team_member
  on public.team_workspace_config
  for update to authenticated
  using (app.is_team_member(team_id))
  with check (app.is_team_member(team_id));

create policy team_workspace_config_delete_if_owner
  on public.team_workspace_config
  for delete to authenticated
  using (
    exists (
      select 1 from public.team_members tm
       join public.actors a on a.id = tm.member_id
      where tm.team_id = team_workspace_config.team_id
        and a.user_id = auth.uid()
        and tm.role   = 'owner'
    )
  );

grant select, insert, update, delete on public.team_workspace_config to authenticated;
