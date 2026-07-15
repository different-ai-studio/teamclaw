-- Set login passwords for the Supabase service roles.
-- NOTE: change to your own passwords for production environments.
-- Only roles that actually exist in this image are altered (the set of
-- pre-created roles varies slightly between supabase/postgres releases).
\set pgpass `echo "$POSTGRES_PASSWORD"`

-- Stash the password in a session GUC: psql does NOT interpolate :vars inside
-- dollar-quoted blocks, so we read it back via current_setting() below.
select set_config('teamclaw.pgpass', :'pgpass', false);

do $$
declare
  r  text;
  pw text := current_setting('teamclaw.pgpass');
begin
  foreach r in array array[
    'authenticator',
    'pgbouncer',
    'supabase_auth_admin',
    'supabase_functions_admin',
    'supabase_storage_admin'
  ]
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter role %I with login password %L', r, pw);
    end if;
  end loop;
end $$;
