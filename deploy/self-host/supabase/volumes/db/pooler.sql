\set pguser `echo "${POSTGRES_USER:-postgres}"`

\c _supabase
create schema if not exists _supavisor;
alter schema _supavisor owner to :pguser;
grant all on schema _supavisor to :pguser;
