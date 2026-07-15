-- 20260517100002_shortcuts_table.sql
-- Personal + team shortcuts, tree via parent_id.
-- Visibility for team scope is governed by public.permissions (see RBAC tables).

create table public.shortcuts (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('personal','team')),
  owner_member_id uuid null references public.members(id) on delete cascade,
  team_id         uuid null references public.teams(id)    on delete cascade,
  parent_id       uuid null references public.shortcuts(id) on delete cascade,
  label text not null,
  icon text null,
  "order" int not null default 0,
  node_type text not null check (node_type in ('native','link','folder')),
  target text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shortcuts_scope_owner_xor check (
    (scope = 'personal' and owner_member_id is not null and team_id is null) or
    (scope = 'team'     and team_id        is not null and owner_member_id is null)
  )
);

create index shortcuts_personal_idx on public.shortcuts (owner_member_id) where scope = 'personal';
create index shortcuts_team_idx     on public.shortcuts (team_id)         where scope = 'team';
create index shortcuts_parent_idx   on public.shortcuts (parent_id);

alter table public.shortcuts enable row level security;
