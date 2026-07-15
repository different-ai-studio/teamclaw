-- 20260517100004_rbac_shortcuts_rls.sql

-- team_roles
create policy team_roles_select_if_member on public.team_roles
for select to authenticated
using (app.is_team_member(team_id));

create policy team_roles_write_if_admin on public.team_roles
for all to authenticated
using       (app.is_team_admin_or_owner(team_id))
with check  (app.is_team_admin_or_owner(team_id));

-- team_member_roles  (decision: SELECT open to all team members)
create policy team_member_roles_select_if_member on public.team_member_roles
for select to authenticated
using (app.is_team_member(team_id));

create policy team_member_roles_write_if_admin on public.team_member_roles
for all to authenticated
using       (app.is_team_admin_or_owner(team_id))
with check  (app.is_team_admin_or_owner(team_id));

-- permissions
create policy permissions_select_if_member on public.permissions
for select to authenticated
using (app.is_team_member(team_id));

create policy permissions_write_if_admin on public.permissions
for all to authenticated
using       (app.is_team_admin_or_owner(team_id))
with check  (app.is_team_admin_or_owner(team_id));

-- permission_roles  (team reached via permissions)
create policy permission_roles_select_if_member on public.permission_roles
for select to authenticated
using (exists (
  select 1 from public.permissions p
  where p.id = permission_roles.permission_id
    and app.is_team_member(p.team_id)
));

create policy permission_roles_write_if_admin on public.permission_roles
for all to authenticated
using (exists (
  select 1 from public.permissions p
  where p.id = permission_roles.permission_id
    and app.is_team_admin_or_owner(p.team_id)
))
with check (exists (
  select 1 from public.permissions p
  where p.id = permission_roles.permission_id
    and app.is_team_admin_or_owner(p.team_id)
));

-- shortcuts
create policy shortcuts_select_personal on public.shortcuts
for select to authenticated
using (
  scope = 'personal' and owner_member_id = app.current_member_id()
);

create policy shortcuts_select_team on public.shortcuts
for select to authenticated
using (
  scope = 'team' and app.member_can_see_shortcut(id)
);

create policy shortcuts_write_personal on public.shortcuts
for all to authenticated
using       (scope = 'personal' and owner_member_id = app.current_member_id())
with check  (scope = 'personal' and owner_member_id = app.current_member_id());

create policy shortcuts_write_team on public.shortcuts
for all to authenticated
using       (scope = 'team' and app.is_team_admin_or_owner(team_id))
with check  (scope = 'team' and app.is_team_admin_or_owner(team_id));
