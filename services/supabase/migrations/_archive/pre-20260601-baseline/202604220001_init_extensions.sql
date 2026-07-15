create extension if not exists pgcrypto;
create extension if not exists pgtap with schema extensions;

create schema if not exists app;

create or replace function app.bump_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
