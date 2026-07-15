create or replace function public.update_owned_agent_profile(
  p_agent_id uuid,
  p_display_name text,
  p_visibility text default null
)
returns table (
  agent_id uuid,
  display_name text,
  visibility text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth, app
as $$
declare
  v_display_name text := nullif(btrim(p_display_name), '');
  v_visibility text := nullif(btrim(coalesce(p_visibility, '')), '');
begin
  if v_display_name is null then
    raise exception 'display name is required'
      using errcode = '23514';
  end if;

  if v_visibility is not null and v_visibility not in ('personal', 'team') then
    raise exception 'visibility must be personal or team'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
      from public.agents ag
     where ag.id = p_agent_id
       and ag.owner_member_id = app.current_member_id()
  ) then
    raise exception 'only agent owner can update agent profile'
      using errcode = '42501';
  end if;

  update public.actors a
     set display_name = v_display_name,
         updated_at = now()
   where a.id = p_agent_id
     and a.actor_type = 'agent';

  update public.agents ag
     set visibility = coalesce(v_visibility, ag.visibility),
         updated_at = now()
   where ag.id = p_agent_id;

  return query
  select ag.id, a.display_name, ag.visibility, greatest(a.updated_at, ag.updated_at)
    from public.agents ag
    join public.actors a on a.id = ag.id
   where ag.id = p_agent_id;
end;
$$;

revoke all on function public.update_owned_agent_profile(uuid, text, text) from public;
grant execute on function public.update_owned_agent_profile(uuid, text, text) to authenticated;
