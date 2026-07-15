-- ============================================================================
-- Stage 1 of teamclaw × saas-mono integration
-- (spec: docs/specs/2026-06-08-teamclaw-saas-mono-integration.md)
--
-- Brings saas-mono's tenant table `public.orgs` (+ its prerequisites) into the
-- teamclaw database as a MIRROR, so the rest of the integration can be built
-- and tested on our own instance first.
--
-- IMPORTANT — DO NOT APPLY ON THE MERGED saas-mono INSTANCE.
--   On the combined instance saas-mono already owns public.orgs / public.plans.
--   Everything here is idempotent (IF NOT EXISTS) so it is a no-op there, but it
--   must NOT diverge from saas-mono's real DDL. Reconcile before merge:
--     - orgs columns/constraints: keep byte-identical to saas-mono
--     - public.plans below is a STUB (we don't have saas-mono's real plans DDL);
--       replace with the real shape before merge.
-- Additive only: no existing table/function is touched. Clients are unaffected.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Prerequisite 1: audit-column trigger function used by orgs (and saas-mono)
-- ---------------------------------------------------------------------------
create or replace function public.update_audit_columns()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := current_timestamp;
  begin
    new.updated_by := auth.uid();
  exception when others then
    -- auth.uid() may be unavailable outside a request context; leave as-is
    null;
  end;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Prerequisite 2: plans (STUB — reconcile with saas-mono's real DDL before merge)
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id         uuid not null default extensions.uuid_generate_v4(),
  name       text,
  created_at timestamp with time zone not null default current_timestamp,
  constraint plans_pkey primary key (id)
);
comment on table public.plans is
  'STUB mirror of saas-mono public.plans for local integration dev. Replace with real DDL before merge. See docs/specs/2026-06-08-teamclaw-saas-mono-integration.md';

-- ---------------------------------------------------------------------------
-- Tenant table: orgs (mirror of saas-mono public.orgs)
-- ---------------------------------------------------------------------------
create table if not exists public.orgs (
  id                      uuid not null default extensions.uuid_generate_v4(),
  name                    text not null,
  code                    character varying(50) null,
  logo                    text null,
  address                 text null,
  contact                 character varying(50) null,
  phone                   character varying(20) null,
  email                   character varying(100) null,
  status                  character varying(20) not null default 'active'::character varying,
  description             text null,
  created_by              uuid null default auth.uid(),
  created_at              timestamp with time zone not null default current_timestamp,
  updated_by              uuid null default auth.uid(),
  updated_at              timestamp with time zone not null default current_timestamp,
  updated_note            text null,
  domain                  text null,
  onboarding_status       text not null default 'pending'::text,
  onboarding_completed_at timestamp with time zone null,
  plan_id                 uuid null,
  business_stage          text not null default 'operating'::text,
  constraint orgs_pkey primary key (id),
  constraint orgs_code_key unique (code),
  constraint orgs_domain_key unique (domain),
  constraint orgs_plan_id_fkey foreign key (plan_id) references public.plans (id),
  constraint orgs_business_stage_check check (
    business_stage = any (array['operating'::text, 'preparing'::text, 'both'::text])
  ),
  constraint orgs_onboarding_status_check check (
    onboarding_status = any (array['pending'::text, 'completed'::text])
  )
);
comment on table public.orgs is
  'Mirror of saas-mono public.orgs (canonical tenant). saas-mono-owned on the merged instance. See docs/specs/2026-06-08-teamclaw-saas-mono-integration.md';

create index if not exists idx_orgs_code              on public.orgs using btree (code);
create index if not exists idx_orgs_plan_id           on public.orgs using btree (plan_id);
create index if not exists idx_orgs_onboarding_status on public.orgs using btree (onboarding_status);
create index if not exists idx_orgs_name              on public.orgs using btree (name);
create index if not exists idx_orgs_domain            on public.orgs using btree (domain);

drop trigger if exists trg_orgs_update_audit on public.orgs;
create trigger trg_orgs_update_audit
  before update on public.orgs
  for each row execute function public.update_audit_columns();

-- Lock the mirror down: RLS on, no policies yet (only service_role bypasses).
-- saas-mono's real org RLS (get_admin_org_id) lands when we wire tenancy.
alter table public.orgs enable row level security;
