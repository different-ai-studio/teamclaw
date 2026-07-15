alter table public.workspaces
  drop constraint if exists workspaces_team_id_name_key;

alter table public.workspaces
  add constraint workspaces_team_id_agent_id_name_key
  unique (team_id, agent_id, name);
