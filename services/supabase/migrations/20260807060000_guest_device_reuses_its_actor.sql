-- A device's guest is ONE member, not one per quick trial.
--
-- Reusing the team was only half the fix. Every quick trial still mints a new
-- anonymous auth user, and the returning guest was inserted as another actor —
-- so the team stopped multiplying but its member list did not. Three trials
-- produced three members with the same name in the same team.
--
-- The device's guest identity is one identity; the anonymous auth user is a
-- credential that rotates under it. So point the existing actor at the new
-- auth user instead of adding another. The abandoned auth user keeps existing
-- with no actor, which is what an expired credential should look like.
alter table amux.guest_device_teams
  add column if not exists member_id uuid references amux.actors(id) on delete set null;

comment on column amux.guest_device_teams.member_id is
  'The one guest actor for this device. Repointed to each new anonymous auth user rather than duplicated.';

-- Backfill: adopt the oldest member actor of each remembered team, which is
-- the one the first guest created.
update amux.guest_device_teams gdt
   set member_id = (
     select a.id from amux.actors a
      where a.team_id = gdt.team_id and a.actor_type = 'member'
      order by a.created_at asc, a.id asc
      limit 1
   )
 where gdt.member_id is null;

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
  v_existing_member uuid;
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

  select gdt.team_id, gdt.member_id into v_existing_team, v_existing_member
    from amux.guest_device_teams gdt
    join amux.teams t on t.id = gdt.team_id
   where gdt.device_id = v_device;

  if v_existing_team is null then
    -- First guest on this device: normal bootstrap, then remember both the
    -- team and the actor it created.
    return query
      with created as (
        select * from amux.bootstrap_current_org_team(p_fallback_org, p_display_name)
      ), remembered as (
        insert into amux.guest_device_teams (device_id, team_id, member_id)
        select v_device, c.team_id, c.member_id from created c
        on conflict (device_id) do nothing
        returning 1
      )
      select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
        from created c;
    return;
  end if;

  select * into v_team from amux.teams where id = v_existing_team;

  -- Already this user's actor (same session coming back): nothing to move.
  select a.id into v_member_id
    from amux.actors a
   where a.user_id = v_user_id and a.team_id = v_existing_team
   limit 1;

  if v_member_id is null then
    -- Take over the remembered actor rather than adding one. Verify it is
    -- still a member of this team — a stale id (actor deleted, or the backfill
    -- picked one that has since gone) must not silently retarget someone else.
    select a.id into v_member_id
      from amux.actors a
     where a.id = v_existing_member
       and a.team_id = v_existing_team
       and a.actor_type = 'member';

    if v_member_id is not null then
      update amux.actors
         set user_id = v_user_id,
             display_name = coalesce(nullif(btrim(p_display_name), ''), display_name),
             last_active_at = now()
       where id = v_member_id;
    else
      -- No usable actor to adopt: make one, and remember it this time.
      v_member_id := gen_random_uuid();
      insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
        values (v_member_id, v_existing_team, 'member', v_user_id,
                coalesce(nullif(btrim(p_display_name), ''), 'Guest'), now());
      insert into amux.members (id, status) values (v_member_id, 'active');
      insert into amux.team_members (team_id, member_id, role) values (v_existing_team, v_member_id, 'member');
      update amux.guest_device_teams set member_id = v_member_id where device_id = v_device;
    end if;
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
