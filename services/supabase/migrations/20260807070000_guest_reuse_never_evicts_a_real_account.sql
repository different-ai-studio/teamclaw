-- Guest reuse must never take an actor away from a signed-up account.
--
-- `claim_guest_device_team` adopted the remembered actor after checking only
-- that it still exists, still belongs to the team, and is a member. Nothing
-- checked whose actor it currently is. But the whole point of the guest path
-- (see 20260807030000) is that attaching an email identity upgrades the same
-- auth user in place and keeps the team — so the remembered actor routinely
-- stops being anonymous. After that, the next quick trial on that machine
-- would repoint it at a walk-up guest: the real account silently loses the
-- team, its owner role and everything in it, and the guest inherits all of it.
--
-- Adopt the actor only while its current owner is still anonymous. Once it has
-- been upgraded the device's guest slot is spent, and a new guest gets a fresh
-- team of its own rather than someone else's.
--
-- Same reason the caller must be anonymous: a signed-in user reaching this
-- function (directly via PostgREST, or through a client bug) must not be able
-- to graft themselves onto a device's guest team either.
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
  v_is_anonymous boolean;
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

  select coalesce(is_anonymous, false) into v_is_anonymous from auth.users where id = v_user_id;
  if not coalesce(v_is_anonymous, false) then
    raise exception 'claim_guest_device_team is for anonymous callers only' using errcode = '42501';
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
    -- Adopt the remembered actor ONLY while its owner is still anonymous.
    select a.id into v_member_id
      from amux.actors a
      join auth.users au on au.id = a.user_id
     where a.id = v_existing_member
       and a.team_id = v_existing_team
       and a.actor_type = 'member'
       and coalesce(au.is_anonymous, false);

    if v_member_id is not null then
      update amux.actors
         set user_id = v_user_id,
             display_name = coalesce(nullif(btrim(p_display_name), ''), display_name),
             last_active_at = now()
       where id = v_member_id;
    else
      -- The remembered actor is gone, or has been upgraded to a real account.
      -- Either way this device's guest slot no longer points at something a
      -- guest may have. Forget it and bootstrap a fresh team, rather than
      -- joining a team that now belongs to somebody.
      delete from amux.guest_device_teams where device_id = v_device;
      return query
        with created as (
          select * from amux.bootstrap_current_org_team(p_fallback_org, p_display_name)
        ), remembered as (
          insert into amux.guest_device_teams (device_id, team_id, member_id)
          select v_device, c.team_id, c.member_id from created c
          on conflict (device_id) do update
            set team_id = excluded.team_id,
                member_id = excluded.member_id,
                claimed_at = now()
          returning 1
        )
        select c.team_id, c.team_name, c.team_slug, c.member_id, c.role, c.workspace_id, c.workspace_name
          from created c;
      return;
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
