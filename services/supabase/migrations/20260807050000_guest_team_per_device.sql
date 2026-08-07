-- One guest team per device, instead of one per quick-trial click.
--
-- Every `signInAnonymously()` mints a fresh auth user, so signing out and
-- trying again produced another guest and another team. The teams pile up in
-- the shared default org forever — nothing ever collects them.
--
-- So remember which team a device's guest got, and hand the same team to the
-- next guest from that device. This is a housekeeping measure, NOT a security
-- boundary: the id lives in the client's own storage, so clearing app data or
-- using another machine gets a fresh team. It stops accumulation from ordinary
-- use, and that is all it is for.
create table if not exists amux.guest_device_teams (
  device_id  text primary key,
  team_id    uuid not null references amux.teams(id) on delete cascade,
  created_at timestamptz not null default now(),
  claimed_at timestamptz not null default now()
);

comment on table amux.guest_device_teams is
  'device_id → the guest team that device already has. Reuse target for quick trial; not an identity or an access control.';

-- No RLS policies: this table is only ever touched by the SECURITY DEFINER
-- function below. Default deny is what we want for everyone else.
alter table amux.guest_device_teams enable row level security;

-- Bootstrap-or-reuse for a guest, atomic.
--
-- Returns the same shape as bootstrap_current_org_team so FC can swap between
-- them without reshaping the response.
create or replace function amux.claim_guest_device_team(
  p_device_id text,
  p_fallback_org uuid default null,
  p_display_name text default null
)
returns table(team_id uuid, team_name text, team_slug text, member_id uuid, role text, workspace_id uuid, workspace_name text)
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_device text := nullif(btrim(p_device_id), '');
  v_existing_team uuid;
  v_member_id uuid;
  v_workspace_id uuid;
  v_workspace_name text;
  v_team amux.teams%rowtype;
begin
  if v_user_id is null then
    raise exception 'claim_guest_device_team requires an authenticated user' using errcode = '42501';
  end if;
  if v_device is null then
    raise exception 'claim_guest_device_team requires a device id' using errcode = '23514';
  end if;

  -- Serialize per device, not per user: two guests racing from the same device
  -- is exactly the case this exists to collapse.
  perform pg_advisory_xact_lock(hashtextextended(v_device, 0));

  select gdt.team_id into v_existing_team
    from amux.guest_device_teams gdt
    join amux.teams t on t.id = gdt.team_id
   where gdt.device_id = v_device;

  if v_existing_team is null then
    -- First guest on this device: normal bootstrap, then remember it.
    return query
      with created as (
        select * from amux.bootstrap_current_org_team(p_fallback_org, p_display_name)
      ), remembered as (
        insert into amux.guest_device_teams (device_id, team_id)
        select v_device, c.team_id from created c
        on conflict (device_id) do nothing
        returning 1
      )
      select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
        from created c;
    return;
  end if;

  -- Returning guest on a known device: join the remembered team rather than
  -- making another one. `bootstrap_current_org_team` cannot be reused here —
  -- create_team is first-team-only and would refuse.
  select * into v_team from amux.teams where id = v_existing_team;

  select a.id into v_member_id
    from amux.actors a
   where a.user_id = v_user_id and a.team_id = v_existing_team
   limit 1;

  if v_member_id is null then
    v_member_id := gen_random_uuid();
    insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
      values (v_member_id, v_existing_team, 'member',  v_user_id,
              coalesce(nullif(btrim(p_display_name), ''), 'Guest'), now());
    insert into amux.members (id, status) values (v_member_id, 'active');
    insert into amux.team_members (team_id, member_id, role) values (v_existing_team, v_member_id, 'member');
  end if;

  update amux.guest_device_teams set claimed_at = now() where device_id = v_device;

  select w.id, w.name into v_workspace_id, v_workspace_name
    from amux.workspaces w
   where w.team_id = v_existing_team
   order by w.created_at asc, w.id asc
   limit 1;

  return query select v_team.id, v_team.name, v_team.slug, v_member_id,
    case when exists (
      select 1 from amux.team_members tm
       where tm.team_id = v_existing_team and tm.member_id = v_member_id and tm.role = 'owner'
    ) then 'owner' else 'member' end,
    v_workspace_id, v_workspace_name;
end;
$function$;

grant execute on function amux.claim_guest_device_team(text, uuid, text) to authenticated;
