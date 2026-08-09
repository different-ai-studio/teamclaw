-- PostgREST loads its schema cache as `authenticator`. Without USAGE on
-- `amux`, RPCs in that schema (e.g. list_teams_for_picker) are invisible in
-- the cache and clients get PGRST202 even though the function exists.
-- Baseline only granted anon / authenticated / service_role.

grant usage on schema amux to authenticator;
