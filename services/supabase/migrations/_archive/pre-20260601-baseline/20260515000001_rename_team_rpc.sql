-- rename_team RPC: lets a team owner/admin update the team's display name.
-- RLS on public.teams only exposes SELECT to members, so updates have to go
-- through a security-definer function that re-checks role authorization.

create or replace function public.rename_team(
  p_team_id uuid,
  p_name text
)
returns table (
  team_id uuid,
  team_name text,
  team_slug text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_new_name text;
begin
  if v_user_id is null then
    raise exception 'rename_team requires an authenticated user'
      using errcode = '42501';
  end if;

  if p_team_id is null then
    raise exception 'team id is required'
      using errcode = '22023';
  end if;

  v_new_name := btrim(coalesce(p_name, ''));
  if v_new_name = '' then
    raise exception 'team name is required'
      using errcode = '22023';
  end if;

  if length(v_new_name) > 80 then
    raise exception 'team name too long (max 80 characters)'
      using errcode = '22001';
  end if;

  -- Caller must be an active owner or admin of the team.
  select tm.role
  into v_role
  from public.team_members tm
  join public.members m on m.id = tm.member_id
  where tm.team_id = p_team_id
    and m.user_id = v_user_id
    and m.status = 'active'
  limit 1;

  if v_role is null then
    raise exception 'not a member of this team'
      using errcode = '42501';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'only team owners or admins can rename the team'
      using errcode = '42501';
  end if;

  update public.teams
  set name = v_new_name
  where id = p_team_id;

  return query
  select
    t.id,
    t.name,
    t.slug
  from public.teams t
  where t.id = p_team_id;
end;
$$;

revoke all on function public.rename_team(uuid, text) from public;
grant execute on function public.rename_team(uuid, text) to authenticated;
