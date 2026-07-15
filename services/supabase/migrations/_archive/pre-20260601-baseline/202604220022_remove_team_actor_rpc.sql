-- Remove an actor (member or agent) from their team. Owners and admins of
-- the actor's team may call this. Cascades: team_members row is deleted,
-- members/agents detail row is deleted, the actor row is deleted, and any
-- agent_member_access rows pointing at the actor go too. Refuses to remove
-- the caller's own actor to prevent accidental self-eviction.

create or replace function public.remove_team_actor(p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth, app
as $$
declare
  v_team_id uuid;
  v_actor_type text;
  v_caller_actor uuid := app.current_actor_id();
begin
  if v_caller_actor is null then
    raise exception 'remove_team_actor requires authentication'
      using errcode = '42501';
  end if;

  select team_id, actor_type
    into v_team_id, v_actor_type
  from public.actors
  where id = p_actor_id;

  if v_team_id is null then
    raise exception 'actor not found'
      using errcode = '23503';
  end if;

  if v_caller_actor = p_actor_id then
    raise exception 'cannot remove your own actor'
      using errcode = '42501';
  end if;

  if app.current_team_role(v_team_id) not in ('owner', 'admin') then
    raise exception 'remove_team_actor requires owner or admin'
      using errcode = '42501';
  end if;

  if v_actor_type = 'member' and exists (
    select 1 from public.team_members
     where team_id = v_team_id and member_id = p_actor_id and role = 'owner'
  ) then
    if (select count(*) from public.team_members
          where team_id = v_team_id and role = 'owner') <= 1 then
      raise exception 'cannot remove the last owner'
        using errcode = '23514';
    end if;
  end if;

  delete from public.agent_member_access
   where agent_id = p_actor_id or member_id = p_actor_id;

  delete from public.team_members where member_id = p_actor_id;

  if v_actor_type = 'member' then
    delete from public.members where id = p_actor_id;
  else
    delete from public.agents where id = p_actor_id;
  end if;

  delete from public.actors where id = p_actor_id;
end;
$$;

revoke all on function public.remove_team_actor(uuid) from public;
grant execute on function public.remove_team_actor(uuid) to authenticated;
