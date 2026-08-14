-- Team skills registry: editing is open to every team member.
--
-- 20260806000000_team_skills_registry.sql gated update / delete / version
-- insert on "skill owner or team admin". That made the registry read like
-- personal property inside a team space: a member who spotted a wrong step in
-- a shared skill could not fix it, and the one exit — publish a near-duplicate
-- under a new slug — is exactly the duplication the registry exists to stop.
--
-- The publish gate stays what the design says it is: the required fields, not
-- an approver. `owner_actor_id` keeps its meaning ("who is responsible for
-- this") and its display; it is simply no longer a permission.
--
-- Deliberately unchanged: team_skill_installs. Writing an install record puts
-- files on somebody's machine, which is a different act from editing shared
-- content — its three gates (self / team agent as admin / never somebody
-- else's member actor) stay exactly as they were.
--
-- Mirrors the application-level model in services/fc/src/lib/pg-repo/team-skills.ts.
-- Design: docs/architecture/team-skills-registry.md §5.

drop policy if exists team_skills_update_if_owner_or_admin on amux.team_skills;
drop policy if exists team_skills_update_if_member on amux.team_skills;
create policy team_skills_update_if_member on amux.team_skills
  for update using (amux.is_team_member(team_id));

drop policy if exists team_skills_delete_if_owner_or_admin on amux.team_skills;
drop policy if exists team_skills_delete_if_member on amux.team_skills;
create policy team_skills_delete_if_member on amux.team_skills
  for delete using (amux.is_team_member(team_id));

drop policy if exists team_skill_versions_insert_if_owner_or_admin on amux.team_skill_versions;
drop policy if exists team_skill_versions_insert_if_member on amux.team_skill_versions;
create policy team_skill_versions_insert_if_member on amux.team_skill_versions
  for insert with check (
    exists (
      select 1 from amux.team_skills s
      where s.id = skill_id and amux.is_team_member(s.team_id)
    )
  );
