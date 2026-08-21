-- Marketplace catalog tables were created without service_role GRANTs.
-- FC admin publish uses the service-role PostgREST client; BYPASSRLS alone
-- is not enough — table privileges are still required.
-- Idempotent: safe if 20260821000000 was patched before first apply.
--
-- team_skills / team_skill_versions grants for lazy align live in
-- 20260821110000_team_skills_service_role_grants.sql (separate so already-
-- applied self-host markers still pick them up).

grant select, insert, update, delete on amux.marketplace_skills to service_role;
grant select, insert, update, delete on amux.marketplace_skill_versions to service_role;
