-- Apps module: per-app provisioned workspaces (TanStack + Postgres template apps).
--
-- Mirrors the Drizzle schema in services/fc/src/db/schema/apps.ts and the RLS
-- visibility pattern used by amux.agents / amux.agent_member_access.
--
-- Schema note: this migration runs AFTER 20260608010000_move_teamclaw_to_amux.sql,
-- which moves every teamclaw business table out of `public` into the `amux` schema
-- (amux.actors / amux.members / amux.agents / amux.sessions / amux.teams /
-- amux.workspaces). So this migration creates amux.apps / amux.app_member_access
-- and references amux.teams / amux.actors / amux.members / amux.workspaces /
-- amux.sessions. RLS helpers live in `amux` on the partner RDS (no `app` schema):
-- `amux.is_team_member`, `amux.current_actor_id_for_team`, `amux.current_member_id`.
-- See `services/supabase/s4/LIVE-CLONE.md`.
-- RLS is the row-access mechanism, but because amux.apps / amux.app_member_access
-- are created directly in amux (rather than moved from public), they inherit no
-- table-level privileges — so per-table GRANTs to the API roles + a PostgREST
-- schema reload are issued at the end of this file (see "PostgREST visibility").
--
-- Identity note: members.id references actors.id (members PK = actors PK), so an
-- actor id and the corresponding member id share the same value. The
-- app_member_access.member_id (FK -> members.id) is therefore comparable to
-- amux.current_actor_id_for_team(...) (returns actors.id) and to
-- amux.current_member_id() (returns actors.id joined to members).

-- ===========================================================================
-- 1. amux.apps
-- ===========================================================================
create table if not exists amux.apps (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references amux.teams(id) on delete cascade,
  created_by_actor_id uuid not null references amux.actors(id) on delete restrict,
  name text not null,
  slug text not null,
  type text not null,
  visibility text not null default 'personal'
    check (visibility in ('personal', 'team')),
  workspace_id uuid references amux.workspaces(id) on delete set null,
  git_remote_url text,
  git_auth_kind text,
  provision_status text not null default 'pending'
    check (provision_status in ('pending', 'repo_created', 'seeding', 'ready', 'error')),
  provision_error text,
  fc_function_name text,
  fc_region text,
  fc_endpoint text,
  fc_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint apps_team_slug_uniq unique (team_id, slug),
  constraint apps_workspace_uniq unique (workspace_id)
);

-- ===========================================================================
-- 2. app_member_access
-- ===========================================================================
create table if not exists amux.app_member_access (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references amux.apps(id) on delete cascade,
  member_id uuid not null references amux.members(id) on delete cascade,
  permission_level text not null
    check (permission_level in ('view', 'prompt', 'admin')),
  granted_by_member_id uuid null references amux.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_member_access_app_member_uniq unique (app_id, member_id)
);

-- ===========================================================================
-- 3. sessions.app_id
-- ===========================================================================
alter table amux.sessions
  add column if not exists app_id uuid references amux.apps(id) on delete set null;

-- ===========================================================================
-- 4. RLS — mirrors amux.agents / amux.agent_member_access visibility.
-- ===========================================================================
alter table amux.apps enable row level security;
alter table amux.app_member_access enable row level security;

-- Explicit-grant lookup, SECURITY DEFINER so it bypasses RLS on
-- amux.app_member_access. This is REQUIRED to avoid an infinite-recursion RLS
-- cycle (Postgres 42P17): apps_select_if_visible would otherwise sub-select
-- app_member_access (whose own SELECT policy sub-selects apps), and the two
-- policies recurse into each other. The amux.agents pattern this mirrors does
-- NOT have this back-edge (agents_select_if_visible never references
-- agent_member_access), so the recursion is unique to apps' "members explicitly
-- granted access can see personal apps" clause. Wrapping that lookup in a
-- SECURITY DEFINER function breaks the cycle while preserving the semantics.
create or replace function amux.actor_has_app_access(p_app_id uuid, p_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = amux, public
as $$
  select exists (
    select 1
      from amux.app_member_access ama
     where ama.app_id = p_app_id
       and ama.member_id = p_actor_id
  );
$$;

-- apps SELECT — visible to team members for team apps; for personal apps only to
-- the creator or members explicitly granted access.
drop policy if exists apps_select_if_visible on amux.apps;
create policy apps_select_if_visible on amux.apps
for select to authenticated using (
  amux.is_team_member(apps.team_id)
  and (
    apps.visibility = 'team'
    or apps.created_by_actor_id = amux.current_actor_id_for_team(apps.team_id)
    or amux.actor_has_app_access(apps.id, amux.current_actor_id_for_team(apps.team_id))
  )
);

-- apps INSERT — caller must be a team member and own the new row.
drop policy if exists apps_insert_if_team_member on amux.apps;
create policy apps_insert_if_team_member on amux.apps
for insert to authenticated with check (
  amux.is_team_member(apps.team_id)
  and apps.created_by_actor_id = amux.current_actor_id_for_team(apps.team_id)
);

-- apps UPDATE — only the creator.
drop policy if exists apps_update_if_creator on amux.apps;
create policy apps_update_if_creator on amux.apps
for update to authenticated using (
  apps.created_by_actor_id = amux.current_actor_id_for_team(apps.team_id)
) with check (
  apps.created_by_actor_id = amux.current_actor_id_for_team(apps.team_id)
);

-- app_member_access SELECT — self rows, or rows on apps I own.
drop policy if exists app_member_access_select on amux.app_member_access;
create policy app_member_access_select on amux.app_member_access
for select to authenticated using (
  member_id = amux.current_member_id()
  or exists (
    select 1
      from amux.apps a
     where a.id = app_member_access.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
);

-- app_member_access manage (ALL) — only the app owner.
drop policy if exists app_member_access_manage on amux.app_member_access;
create policy app_member_access_manage on amux.app_member_access
for all to authenticated using (
  exists (
    select 1
      from amux.apps a
     where a.id = app_member_access.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
) with check (
  exists (
    select 1
      from amux.apps a
     where a.id = app_member_access.app_id
       and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)
  )
);

-- ===========================================================================
-- PostgREST visibility for the new amux tables.
--
-- RLS governs row access, but the tables still need table-level privileges
-- granted to the API roles. Tables created directly in amux (vs. the ones that
-- moved from public in 20260608010000, which carried their grants with them via
-- `alter table ... set schema`) do NOT inherit any grants. Without these,
-- PostgREST returns "permission denied" before RLS is even consulted. We match
-- the amuxc_* idiom from the baseline: DML to authenticated, all to service_role
-- (anon gets schema usage but no table privileges).
--
-- The PKs use gen_random_uuid() (no serial/sequence columns), so no sequence
-- grants are required.
-- ===========================================================================
grant select, insert, update, delete on amux.apps to authenticated;
grant select, insert, update, delete on amux.app_member_access to authenticated;
grant all on amux.apps to service_role;
grant all on amux.app_member_access to service_role;

-- Reload PostgREST schema cache so the new tables/columns are exposed.
notify pgrst, 'reload schema';
