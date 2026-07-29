-- Agent delete authz: personal agents → owner only; team agents → owner/admin.
-- FK blockers → stable error tokens for client messaging.
-- actor_directory: expose owner_member_id for client-side remove gating.

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
  v_agent_visibility text;
  v_agent_owner_member_id uuid;
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

  if v_actor_type = 'agent' then
    select visibility, owner_member_id
      into v_agent_visibility, v_agent_owner_member_id
    from amux.agents
    where id = p_actor_id;

    if v_agent_visibility = 'personal' then
      if v_caller_actor is distinct from v_agent_owner_member_id then
        raise exception 'remove_team_actor requires agent owner for personal agents'
          using errcode = '42501';
      end if;
    elsif v_agent_visibility = 'team' then
      if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
        raise exception 'remove_team_actor requires owner or admin for team agents'
          using errcode = '42501';
      end if;
    else
      if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
        raise exception 'remove_team_actor requires owner or admin'
          using errcode = '42501';
      end if;
    end if;
  else
    if amux.current_team_role(v_team_id) not in ('owner', 'admin') then
      raise exception 'remove_team_actor requires owner or admin'
        using errcode = '42501';
    end if;
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

  begin
    -- Member removal: cascade-delete agents they own before dropping the member row.
    if v_actor_type = 'member' then
      for v_owned_agent_id in
        select id from amux.agents where owner_member_id = p_actor_id
      loop
        delete from amux.agent_member_access
         where agent_id = v_owned_agent_id or member_id = v_owned_agent_id;

        delete from amux.team_members
         where member_id = v_owned_agent_id;

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
  exception
    when foreign_key_violation then
      raise exception '%', case
        when sqlerrm ilike '%idea_activities%' then 'agent_delete_blocked_by_idea_activities'
        when sqlerrm ilike '%apps_created_by%' or sqlerrm ilike '%apps_%actor%' then 'agent_delete_blocked_by_apps'
        when sqlerrm ilike '%amuxc_file%' then 'agent_delete_blocked_by_files'
        else 'actor_delete_blocked_by_references'
      end
      using errcode = '23503';
  end;
end;
$$;

comment on function amux.remove_team_actor(uuid) is
  'Remove a team actor. Members: owner/admin. Personal agents: owner_member only. Team agents: owner/admin. Cascades owned agents when removing a member.';

drop view if exists amux.actor_directory;

create view amux.actor_directory
  with (security_invoker = true)
as
select
  a.id, a.team_id, a.actor_type, a.user_id, a.invited_by_actor_id,
  a.display_name, a.avatar_url, a.last_active_at, a.created_at, a.updated_at,
  m.status      as member_status,
  tm.role       as team_role,
  ag.agent_types,
  ag.default_agent_type,
  ag.default_workspace_id,
  ag.visibility as agent_visibility,
  ag.status     as agent_status,
  ag.owner_member_id,
  c.email       as user_email,
  c.phone       as user_phone
from amux.actors a
left join amux.members      m  on m.id         = a.id
left join amux.team_members tm on tm.member_id = a.id
left join amux.agents       ag on ag.id        = a.id
left join lateral amux.actor_user_contact(a.user_id) c
  on a.actor_type <> 'agent' and a.user_id is not null
where a.actor_type <> 'agent'
   or ag.visibility = 'team'
   or ag.owner_member_id = amux.current_actor_id_for_team(a.team_id);

grant select on amux.actor_directory to authenticated;
