-- 20260517100003_rbac_shortcuts_helpers.sql
-- SECURITY DEFINER helpers used by RLS policies. They are explicitly
-- search_path-pinned (per services/supabase/migrations/202604220004_*).

create or replace function app.is_team_admin_or_owner(target_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select app.current_team_role(target_team_id) in ('owner','admin')
$$;

-- Open default: if no permission_roles bindings exist for the permission,
-- every team member can see the underlying resource. Otherwise, the current
-- member must hold at least one bound role.
create or replace function app.member_can_access_permission(target_permission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select case
    when not exists (
      select 1 from public.permission_roles where permission_id = target_permission_id
    ) then true
    else exists (
      select 1
      from public.permission_roles pr
      join public.team_member_roles tmr on tmr.role_id = pr.role_id
      where pr.permission_id = target_permission_id
        and tmr.member_id = app.current_member_id()
    )
  end
$$;

-- Visibility check used by shortcuts RLS for team-scope rows.
create or replace function app.member_can_see_shortcut(target_shortcut_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  with sc as (
    select scope, owner_member_id, team_id from public.shortcuts where id = target_shortcut_id
  )
  select case
    when (select scope from sc) = 'personal'
      then (select owner_member_id from sc) = app.current_member_id()
    when (select scope from sc) = 'team'
      then app.is_team_member((select team_id from sc))
       and app.member_can_access_permission((
         select id from public.permissions
         where team_id = (select team_id from sc)
           and resource_type = 'shortcut'
           and resource_id = target_shortcut_id
       ))
  end
$$;

revoke all on function app.is_team_admin_or_owner(uuid) from public;
revoke all on function app.member_can_access_permission(uuid) from public;
revoke all on function app.member_can_see_shortcut(uuid) from public;
grant execute on function app.is_team_admin_or_owner(uuid) to authenticated;
grant execute on function app.member_can_access_permission(uuid) to authenticated;
grant execute on function app.member_can_see_shortcut(uuid) to authenticated;
