alter table public.sessions
  drop constraint if exists sessions_idea_id_fkey;

alter table public.sessions
  alter column idea_id drop not null;

alter table public.sessions
  add constraint sessions_idea_id_fkey
  foreign key (idea_id) references public.ideas(id) on delete set null;

create or replace function public.create_session(
  p_primary_agent_id uuid,
  p_idea_id uuid,
  p_mode text,
  p_title text
)
returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_caller_member uuid := app.current_member_id();
  v_team uuid;
  v_session uuid;
begin
  if v_caller_member is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_idea_id is not null then
    select team_id into v_team from public.ideas where id = p_idea_id;
    if v_team is null then
      raise exception 'idea not found' using errcode = 'P0001';
    end if;
  else
    v_team := app.actor_team_id(p_primary_agent_id);
  end if;

  if v_team is null then
    raise exception 'agent not in team' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.team_members
    where team_id = v_team and member_id = v_caller_member
  ) then
    raise exception 'caller not in team' using errcode = '42501';
  end if;

  if app.actor_team_id(p_primary_agent_id) <> v_team then
    raise exception 'agent not in team' using errcode = '42501';
  end if;

  insert into public.sessions
    (team_id, idea_id, created_by_actor_id, primary_agent_id, mode, title)
    values (v_team, p_idea_id, v_caller_member, p_primary_agent_id, p_mode, p_title)
    returning id into v_session;

  insert into public.session_participants (session_id, actor_id) values
    (v_session, v_caller_member),
    (v_session, p_primary_agent_id)
  on conflict (session_id, actor_id) do nothing;

  return v_session;
end;
$$;

