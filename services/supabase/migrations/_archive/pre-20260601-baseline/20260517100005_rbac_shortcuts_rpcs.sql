-- 20260517100005_rbac_shortcuts_rpcs.sql

-- 1) Create shortcut. Team scope also inserts the permissions registry row
--    in the same tx.
create or replace function public.shortcut_create(
  p_scope text,
  p_label text,
  p_node_type text,
  p_team_id uuid default null,
  p_parent_id uuid default null,
  p_icon text default null,
  p_order int default 0,
  p_target text default ''
) returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_id uuid;
  v_member uuid := app.current_member_id();
begin
  if v_member is null then
    raise exception 'not authenticated';
  end if;

  if p_scope = 'personal' then
    insert into public.shortcuts (scope, owner_member_id, parent_id, label, icon, "order", node_type, target)
    values ('personal', v_member, p_parent_id, p_label, p_icon, p_order, p_node_type, p_target)
    returning id into v_id;
  elsif p_scope = 'team' then
    if p_team_id is null then
      raise exception 'team_id required for team scope';
    end if;
    if not app.is_team_admin_or_owner(p_team_id) then
      raise exception 'forbidden';
    end if;
    insert into public.shortcuts (scope, team_id, parent_id, label, icon, "order", node_type, target)
    values ('team', p_team_id, p_parent_id, p_label, p_icon, p_order, p_node_type, p_target)
    returning id into v_id;
    insert into public.permissions (team_id, resource_type, resource_id, code)
    values (p_team_id, 'shortcut', v_id, 'shortcut:' || v_id::text);
  else
    raise exception 'invalid scope: %', p_scope;
  end if;

  return v_id;
end $$;

-- 2) Drag/drop batch reorder. Single tx.
create or replace function public.shortcut_batch_move(
  p_moves jsonb   -- [{"id":"...","parent_id":"..."|null,"order":3}, ...]
) returns int
language plpgsql
security definer
set search_path = public, app
as $$
declare v_count int;
begin
  update public.shortcuts s set
    parent_id  = nullif(m->>'parent_id','')::uuid,
    "order"    = (m->>'order')::int,
    updated_at = now()
  from jsonb_array_elements(p_moves) m
  where s.id = (m->>'id')::uuid
    and (
      (s.scope = 'personal' and s.owner_member_id = app.current_member_id())
      or (s.scope = 'team'  and app.is_team_admin_or_owner(s.team_id))
    );
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- 3) Set the FULL set of roles that can see a team shortcut (swap-in).
create or replace function public.shortcut_set_visible_roles(
  p_shortcut_id uuid,
  p_role_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public, app
as $$
declare v_team uuid; v_perm uuid;
begin
  select team_id into v_team from public.shortcuts
    where id = p_shortcut_id and scope = 'team';
  if v_team is null then
    raise exception 'shortcut not found or not team-scoped';
  end if;
  if not app.is_team_admin_or_owner(v_team) then
    raise exception 'forbidden';
  end if;
  select id into v_perm from public.permissions
    where team_id = v_team and resource_type = 'shortcut' and resource_id = p_shortcut_id;
  if v_perm is null then
    raise exception 'permission row missing for shortcut %', p_shortcut_id;
  end if;
  delete from public.permission_roles where permission_id = v_perm;
  if array_length(p_role_ids, 1) is not null then
    insert into public.permission_roles (permission_id, role_id)
      select v_perm, unnest(p_role_ids);
  end if;
end $$;

-- 4) Set the FULL set of custom roles a member holds (swap-in).
create or replace function public.team_member_set_roles(
  p_team_id uuid,
  p_member_id uuid,
  p_role_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public, app
as $$
begin
  if not app.is_team_admin_or_owner(p_team_id) then
    raise exception 'forbidden';
  end if;
  delete from public.team_member_roles
    where team_id = p_team_id and member_id = p_member_id;
  if array_length(p_role_ids, 1) is not null then
    insert into public.team_member_roles (team_id, member_id, role_id)
      select p_team_id, p_member_id, unnest(p_role_ids);
  end if;
end $$;

-- Trigger: when a team shortcut is deleted, also delete its permissions row.
-- (No FK in that direction since permissions is polymorphic via resource_id.)
create or replace function app.cleanup_shortcut_permission()
returns trigger
language plpgsql
security definer
set search_path = public, app
as $$
begin
  if old.scope = 'team' then
    delete from public.permissions
      where team_id = old.team_id
        and resource_type = 'shortcut'
        and resource_id = old.id;
  end if;
  return old;
end $$;

create trigger shortcuts_cleanup_permission_after_delete
  after delete on public.shortcuts
  for each row execute function app.cleanup_shortcut_permission();

revoke all on function public.shortcut_create(text,text,text,uuid,uuid,text,int,text)        from public;
revoke all on function public.shortcut_batch_move(jsonb)                                     from public;
revoke all on function public.shortcut_set_visible_roles(uuid,uuid[])                        from public;
revoke all on function public.team_member_set_roles(uuid,uuid,uuid[])                        from public;
grant execute on function public.shortcut_create(text,text,text,uuid,uuid,text,int,text)     to authenticated;
grant execute on function public.shortcut_batch_move(jsonb)                                  to authenticated;
grant execute on function public.shortcut_set_visible_roles(uuid,uuid[])                     to authenticated;
grant execute on function public.team_member_set_roles(uuid,uuid,uuid[])                     to authenticated;
