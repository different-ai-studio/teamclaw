-- ============================================================================
-- SECURITY FIX (critical): cross-tenant team tampering/deletion.
--
-- The only write policy on amux.teams was `teams_org_guard`, created FOR ALL
-- (i.e. covering INSERT/UPDATE/DELETE) with USING/WITH CHECK =
--   (oid IS NULL) OR (oid = current_org_id())
-- and NO membership check (membership was only enforced by the SELECT-only
-- policy teams_select_if_member). Combined with `GRANT ALL ON amux.teams TO
-- authenticated`, and the fact that every new user's personal team is stamped
-- with the SAME shared DEFAULT_ORG_ID (so current_org_id() resolves to that
-- default org for all default-org users), any authenticated user could
--   DELETE FROM amux.teams WHERE id = <another user's team>
-- (or UPDATE it) — cascading to that team's actors/sessions/messages/
-- workspaces — despite never being a member. RLS is the last line of defense
-- here (the amux schema is exposed via PostgREST), so the FC facade cannot
-- prevent this.
--
-- Fix: replace the FOR ALL org guard with per-command policies. Writes that
-- target an existing row (UPDATE/DELETE) now additionally require the caller to
-- be a member of that team. INSERT stays org-scoped only, because team creation
-- goes through the SECURITY DEFINER amux.create_team() RPC (which bypasses RLS)
-- and no membership exists yet at creation time.
--
-- APPLY WITH the amux schema.
-- ============================================================================

drop policy if exists teams_org_guard on amux.teams;

-- INSERT: org-scoped only. Direct client inserts are not expected (create_team
-- is SECURITY DEFINER), but keep the original org guard as defense in depth.
create policy teams_insert_org_guard on amux.teams
  for insert to authenticated
  with check ((oid is null) or (oid = ( select amux.current_org_id() as current_org_id)));

-- UPDATE: must be a member of the team AND within the caller's org.
create policy teams_update_if_member on amux.teams
  for update to authenticated
  using (amux.is_team_member(id) and ((oid is null) or (oid = ( select amux.current_org_id() as current_org_id))))
  with check (amux.is_team_member(id) and ((oid is null) or (oid = ( select amux.current_org_id() as current_org_id))));

-- DELETE: must be a member of the team AND within the caller's org.
create policy teams_delete_if_member on amux.teams
  for delete to authenticated
  using (amux.is_team_member(id) and ((oid is null) or (oid = ( select amux.current_org_id() as current_org_id))));
