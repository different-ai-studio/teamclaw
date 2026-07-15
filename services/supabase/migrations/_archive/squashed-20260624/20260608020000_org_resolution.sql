-- ============================================================================
-- Stage 3A of teamclaw × saas-mono integration (public-only, additive — safe now)
-- (spec: docs/specs/2026-06-08-teamclaw-saas-mono-integration.md)
--
-- Tenant resolution scaffolding that does NOT depend on the amux move:
--   - public.users  : subset mirror of saas-mono's user↔org mapping
--   - app.current_org_id() : resolve caller's org from JWT (fallback users row)
--   - orgs RLS view policy  : mirror of saas-mono orgs_view_policy
--
-- saas-mono OWNS public.users on the merged instance (full shape). This is an
-- IF NOT EXISTS subset for local dev — reconcile before merge. Better-Auth's
-- `user` (singular) is a different table; no collision.
-- ============================================================================

-- user ↔ org mapping (subset mirror of saas-mono public.users)
create table if not exists public.users (
  id            uuid primary key default extensions.uuid_generate_v4(),
  auth_user_id  uuid references auth.users(id),
  org_id        uuid not null references public.orgs(id),
  admin_type    smallint not null default 1,
  email         text not null default '',
  nickname      text not null default '',
  created_at    timestamp with time zone not null default current_timestamp,
  updated_at    timestamp with time zone not null default current_timestamp
);
comment on table public.users is
  'SUBSET mirror of saas-mono public.users (user↔org). saas-mono-owned on merge; reconcile full shape before merge.';
create index if not exists idx_users_org_id       on public.users(org_id);
create index if not exists idx_users_auth_user_id on public.users(auth_user_id) where auth_user_id is not null;

drop trigger if exists trg_users_update_audit on public.users;
create trigger trg_users_update_audit before update on public.users
  for each row execute function public.update_audit_columns();

-- Resolve the caller's org: JWT app_metadata.org_id first, then users row.
create or replace function app.current_org_id()
returns uuid
language sql stable security definer
set search_path = app, public, auth
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'org_id', '')::uuid,
    (select u.org_id from public.users u where u.auth_user_id = auth.uid() limit 1)
  );
$$;

-- orgs RLS (mirror of saas-mono orgs_view_policy). Writes only via service_role
-- (which bypasses RLS); no write policy added on purpose.
drop policy if exists orgs_view_policy on public.orgs;
create policy orgs_view_policy on public.orgs
  for select using (id = (select app.current_org_id()));
