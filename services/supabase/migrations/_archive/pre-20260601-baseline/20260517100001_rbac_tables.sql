-- 20260517100001_rbac_tables.sql
-- Generic team-scoped RBAC. Shortcuts is the first consumer; channels/agents
-- can adopt the same `permissions` registry later.

create table public.team_roles (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, code)
);

create table public.team_member_roles (
  id uuid primary key default gen_random_uuid(),
  team_id   uuid not null references public.teams(id)      on delete cascade,
  member_id uuid not null references public.members(id)    on delete cascade,
  role_id   uuid not null references public.team_roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (team_id, member_id, role_id)
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  resource_type text not null,
  resource_id   uuid not null,
  code text not null,
  created_at timestamptz not null default now(),
  unique (team_id, resource_type, resource_id),
  unique (team_id, code)
);

create table public.permission_roles (
  id uuid primary key default gen_random_uuid(),
  permission_id uuid not null references public.permissions(id) on delete cascade,
  role_id       uuid not null references public.team_roles(id)  on delete cascade,
  created_at timestamptz not null default now(),
  unique (permission_id, role_id)
);

create index team_member_roles_member_idx on public.team_member_roles (team_id, member_id);
create index permissions_resource_idx     on public.permissions (team_id, resource_type, resource_id);
create index permission_roles_role_idx    on public.permission_roles (role_id);

alter table public.team_roles         enable row level security;
alter table public.team_member_roles  enable row level security;
alter table public.permissions        enable row level security;
alter table public.permission_roles   enable row level security;
