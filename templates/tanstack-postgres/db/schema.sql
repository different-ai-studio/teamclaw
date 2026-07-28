-- App database schema. Add your tables here.
create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  created_at timestamptz not null default now()
);
