-- Skills marketplace — first-party curated catalog for team skills registry.
-- Design: docs/architecture/skills-marketplace.md
--
-- Two catalog tables (global, not team-scoped). Team side gains origin /
-- subscription columns so adopt + lazy align can project marketplace versions
-- into team_skills without a second distribution pipeline.
--
-- Idempotent: self-host apply-migrations re-runs safely.

-- ---------------------------------------------------------------------------
-- 1. marketplace_skills
-- ---------------------------------------------------------------------------
create table if not exists amux.marketplace_skills (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  display_name text not null,
  publisher text not null,
  summary text not null,
  category text not null,
  when_to_use text not null default '',
  when_not_to_use text not null default '',
  requires jsonb,
  tags text[] not null default '{}',
  status text not null default 'draft',
  latest_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_skills_slug_format
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  constraint marketplace_skills_status_valid
    check (status in ('draft', 'published', 'delisted')),
  constraint marketplace_skills_category_valid
    check (category in (
      'general', 'coding', 'devops', 'data',
      'research', 'writing', 'communication', 'integration'
    )),
  constraint marketplace_skills_summary_len
    check (char_length(summary) between 1 and 200)
);

create unique index if not exists uniq_marketplace_skills_slug
  on amux.marketplace_skills (slug);

create index if not exists idx_marketplace_skills_status_category
  on amux.marketplace_skills (status, category);

drop trigger if exists marketplace_skills_bump_updated_at on amux.marketplace_skills;
create trigger marketplace_skills_bump_updated_at
  before update on amux.marketplace_skills
  for each row execute function amux.bump_updated_at();

-- ---------------------------------------------------------------------------
-- 2. marketplace_skill_versions
-- ---------------------------------------------------------------------------
create table if not exists amux.marketplace_skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references amux.marketplace_skills(id) on delete cascade,
  version integer not null,
  content_hash text not null,
  size bigint not null default 0,
  object_path text not null,
  changelog text not null,
  summary text not null,
  when_to_use text not null default '',
  when_not_to_use text not null default '',
  requires jsonb,
  -- null = uploaded but not promoted; latest_version only advances on promote.
  published_at timestamptz,
  -- Key-granularity only (shared MARKETPLACE_ADMIN_SECRET), not a person.
  created_by text,
  created_at timestamptz not null default now(),
  constraint marketplace_skill_versions_version_positive check (version >= 1)
);

create unique index if not exists uniq_marketplace_skill_version
  on amux.marketplace_skill_versions (skill_id, version);

create index if not exists idx_marketplace_skill_versions_skill
  on amux.marketplace_skill_versions (skill_id, version desc);

-- ---------------------------------------------------------------------------
-- 3. team_skills / team_skill_versions — marketplace origin columns
-- ---------------------------------------------------------------------------
alter table amux.team_skills
  add column if not exists origin text not null default 'local',
  add column if not exists upstream_slug text,
  add column if not exists upstream_subscribed boolean not null default false,
  add column if not exists upstream_detached_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_skills_origin_valid'
  ) then
    alter table amux.team_skills
      add constraint team_skills_origin_valid
      check (origin in ('local', 'marketplace'));
  end if;
end $$;

create index if not exists idx_team_skills_upstream_slug_marketplace
  on amux.team_skills (upstream_slug)
  where origin = 'marketplace';

alter table amux.team_skill_versions
  add column if not exists upstream_version integer,
  add column if not exists blob_scope text not null default 'team',
  add column if not exists object_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_skill_versions_blob_scope_valid'
  ) then
    alter table amux.team_skill_versions
      add constraint team_skill_versions_blob_scope_valid
      check (blob_scope in ('team', 'marketplace'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. RLS — catalog is globally readable when published; writes are service-role only
-- ---------------------------------------------------------------------------
alter table amux.marketplace_skills enable row level security;
alter table amux.marketplace_skill_versions enable row level security;

-- Authenticated users may browse published catalog rows. Admin writes go through
-- FC with MARKETPLACE_ADMIN_SECRET and the service-role client (bypasses RLS).
drop policy if exists marketplace_skills_select_published on amux.marketplace_skills;
create policy marketplace_skills_select_published on amux.marketplace_skills
  for select to authenticated
  using (status = 'published');

drop policy if exists marketplace_skill_versions_select_published on amux.marketplace_skill_versions;
create policy marketplace_skill_versions_select_published on amux.marketplace_skill_versions
  for select to authenticated
  using (
    published_at is not null
    and exists (
      select 1 from amux.marketplace_skills s
      where s.id = skill_id and s.status = 'published'
    )
  );

grant select on amux.marketplace_skills to authenticated;
grant select on amux.marketplace_skill_versions to authenticated;
-- Admin publishes via FC + service-role client (bypasses RLS but still needs GRANT).
-- amux is not covered by Supabase's public-schema default privileges.
grant select, insert, update, delete on amux.marketplace_skills to service_role;
grant select, insert, update, delete on amux.marketplace_skill_versions to service_role;
