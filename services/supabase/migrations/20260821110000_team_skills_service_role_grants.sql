-- Lazy marketplace align (GET /v1/teams/:id/skills) uses the service-role
-- client against team_skills / team_skill_versions. Those tables only granted
-- authenticated historically; after the first marketplace adopt, list 500'd
-- with "permission denied for table team_skill_versions".

grant select, insert, update, delete on amux.team_skills to service_role;
grant select, insert, update, delete on amux.team_skill_versions to service_role;
