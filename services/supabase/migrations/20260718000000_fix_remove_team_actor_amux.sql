-- Fix: DELETE /v1/teams/:id/actors/:actorId fails with
--   relation "public.actors" does not exist
--
-- Baseline shipped amux.remove_team_actor with hard-coded public.* table refs
-- and search_path = public,auth,app. After S2 moved business tables to amux,
-- the function body still pointed at the now-missing public.actors (and related
-- tables). Listing still works via amux.actor_directory, so stale agents stay
-- visible in RECENTS while Remove always 500s.
--
-- Same class of bug as 20260609000000_actor_directory_contact_amux.sql:
-- SECURITY DEFINER function bodies are text and do not follow a table's schema
-- move. Rewrite against amux.* and drop the obsolete daemon_invites delete
-- (that table was removed; see tests/001_schema_shape.sql hasnt_table).

create or replace function amux.remove_team_actor(p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_team_id uuid;
  v_actor_type text;
  v_caller_actor uuid := amux.current_actor_id();
  v_owned_agent_id uuid;
begin
  if v_caller_actor is null then
    raise exception 'remove_team_actor requires authentication'
      using errcode = '42501';
  end if;

  select team_id, actor_type
    into v_team_id, v_actor_type
  from amux.actors
  where id = p_actor_id;

  if v_team_id is null then
    raise exception 'actor not found'
      using errcode = '23503';
  end if;

  if v_caller_actor = p_actor_id then
    raise exception 'cannot remove your own actor'
      using errcode = '42501';
  end if;

  if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
    raise exception 'remove_team_actor requires owner or admin'
      using errcode = '42501';
  end if;

  if v_actor_type = 'member' and exists (
    select 1 from amux.team_members
     where team_id = v_team_id and member_id = p_actor_id and role = 'owner'
  ) then
    if (select count(*) from amux.team_members
          where team_id = v_team_id and role = 'owner') <= 1 then
      raise exception 'cannot remove the last owner'
        using errcode = '23514';
    end if;
  end if;

  -- Member removal: cascade-delete agents they own before dropping the member row.
  if v_actor_type = 'member' then
    for v_owned_agent_id in
      select id from amux.agents where owner_member_id = p_actor_id
    loop
      delete from amux.agent_member_access
       where agent_id = v_owned_agent_id or member_id = v_owned_agent_id;

      delete from amux.team_members
       where member_id = v_owned_agent_id;

      -- actors delete cascades to agents (agents.id -> actors.id).
      delete from amux.actors where id = v_owned_agent_id;
    end loop;
  end if;

  delete from amux.agent_member_access
   where agent_id = p_actor_id or member_id = p_actor_id;

  delete from amux.team_members where member_id = p_actor_id;

  if v_actor_type = 'member' then
    delete from amux.members where id = p_actor_id;
  else
    delete from amux.agents where id = p_actor_id;
  end if;

  delete from amux.actors where id = p_actor_id;
end;
$$;

comment on function amux.remove_team_actor(uuid) is
  'Owner/admin: remove a team actor (member or agent). Cascades owned agents when removing a member. Reads/writes amux.* only.';

revoke all on function amux.remove_team_actor(uuid) from public;
grant execute on function amux.remove_team_actor(uuid) to anon;
grant execute on function amux.remove_team_actor(uuid) to authenticated;
grant execute on function amux.remove_team_actor(uuid) to service_role;
