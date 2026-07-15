-- Per-actor, per-device client version snapshot for ops/support debugging.
-- Latest version only, keyed by (actor_id, client_type, device_id).
-- Writes go through a SECURITY DEFINER RPC that resolves the caller's own actor
-- for the team (never trusting a client-supplied actor id), mirroring
-- public.set_member_default_agent. Reads are RLS-gated to team members.

begin;

create table if not exists public.actor_client_versions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.actors(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  client_type text not null,
  device_id text not null,
  version text not null,
  build text,
  last_reported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (actor_id, client_type, device_id)
);

alter table public.actor_client_versions enable row level security;

-- Team members may read version rows for actors in their team.
drop policy if exists actor_client_versions_select on public.actor_client_versions;
create policy actor_client_versions_select
  on public.actor_client_versions
  for select
  using (app.current_actor_id_for_team(team_id) is not null);

-- No direct insert/update/delete from clients; the RPC (security definer) owns writes.

create or replace function public.report_client_version(
  p_team_id uuid,
  p_client_type text,
  p_version text,
  p_device_id text,
  p_build text default null
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_caller uuid := app.current_actor_id_for_team(p_team_id);
begin
  if v_caller is null then
    raise exception 'caller is not a member of this team' using errcode = '42501';
  end if;
  if p_client_type not in ('tauri','ios','expo','daemon') then
    raise exception 'invalid client_type' using errcode = '23514';
  end if;

  insert into public.actor_client_versions
    (actor_id, team_id, client_type, device_id, version, build, last_reported_at)
  values
    (v_caller, p_team_id, p_client_type, p_device_id, p_version, p_build, now())
  on conflict (actor_id, client_type, device_id) do update
    set version = excluded.version,
        build = excluded.build,
        last_reported_at = now();
end;
$$;

revoke all on function public.report_client_version(uuid, text, text, text, text) from public;
grant execute on function public.report_client_version(uuid, text, text, text, text) to authenticated;

commit;
