-- 20260527000001_oss_sync_schema.sql
--
-- OSS Sync v3 (PR1): add sync_mode + waterline columns to
-- team_workspace_config, plus four new tables for content-addressed blob
-- tracking, file pointers, immutable version chain, and prepare/complete
-- upload sessions. Locks down sync-state fields via a BEFORE UPDATE trigger
-- so authenticated callers cannot rewrite the waterline.
--
-- See docs/superpowers/specs/2026-05-27-oss-sync-redesign-design.md §2.

begin;

-- ===========================================================================
-- 1. Extend team_workspace_config
-- ===========================================================================
alter table public.team_workspace_config
  add column if not exists sync_mode text not null default 'git'
    check (sync_mode in ('git', 'oss')),
  add column if not exists oss_change_seq bigint not null default 0,
  add column if not exists litellm_team_id text;

comment on column public.team_workspace_config.sync_mode is
  'Sync backend for this team. Set at team creation; immutable thereafter (enforced by trg_team_workspace_config_guard).';
comment on column public.team_workspace_config.oss_change_seq is
  'Per-team monotonic sequence written by /sync/upload/complete inside the same tx as amuxc_files.change_seq. Manifest high-water mark.';
comment on column public.team_workspace_config.litellm_team_id is
  'LiteLLM team id provisioned for this team during /sync/create-team.';

-- ===========================================================================
-- 2. amuxc_blobs: content-addressed blob registry, per-team isolated
-- ===========================================================================
create table public.amuxc_blobs (
  team_id      uuid        not null references public.teams(id) on delete cascade,
  content_hash text        not null,
  oss_key      text        not null,
  size         bigint      not null check (size >= 0),
  verified     boolean     not null default false,
  created_at   timestamptz not null default now(),
  primary key (team_id, content_hash)
);

create index idx_amuxc_blobs_verified_created
  on public.amuxc_blobs (created_at) where verified = false;

comment on table public.amuxc_blobs is
  'OSS blob registry. (team_id, content_hash) PK acts as a per-team dedup key. verified=false means prepare-stage placeholder, flipped true by /sync/upload/complete.';

-- ===========================================================================
-- 3. amuxc_files: current pointer per path
-- ===========================================================================
create table public.amuxc_files (
  id              uuid        primary key default gen_random_uuid(),
  team_id         uuid        not null references public.teams(id) on delete cascade,
  path            text        not null,
  current_version int         not null default 0,
  content_hash    text,                            -- cipher_hash; null only when deleted
  size            bigint      not null default 0 check (size >= 0),
  deleted         boolean     not null default false,
  change_seq      bigint      not null default 0,
  row_version     int         not null default 0,
  updated_by      uuid        not null references public.actors(id) on delete restrict,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create unique index uniq_amuxc_path
  on public.amuxc_files (team_id, path);
create index idx_amuxc_files_team_updated
  on public.amuxc_files (team_id, updated_at);
create index idx_amuxc_files_team_seq
  on public.amuxc_files (team_id, change_seq);

comment on table public.amuxc_files is
  'Current pointer per (team, path). Soft-delete keeps the same row (deleted=true) so revival increments current_version on the existing row and preserves the immutable version chain in amuxc_file_versions.';
comment on column public.amuxc_files.content_hash is
  'Ciphertext sha256 (see design §3.-1). Null iff deleted=true.';
comment on column public.amuxc_files.change_seq is
  'Per-team manifest sequence, assigned by /sync/upload/complete. See team_workspace_config.oss_change_seq.';

-- ===========================================================================
-- 4. amuxc_file_versions: append-only history
-- ===========================================================================
create table public.amuxc_file_versions (
  id                 uuid        primary key default gen_random_uuid(),
  file_id            uuid        not null references public.amuxc_files(id) on delete cascade,
  version            int         not null,
  parent_version     int         not null,
  content_hash       text,                       -- cipher_hash; null iff deleted version
  size               bigint      not null default 0 check (size >= 0),
  deleted            boolean     not null default false,
  created_by         uuid        not null references public.actors(id) on delete restrict,
  created_by_node_id text,
  message            text,
  created_at         timestamptz not null default now(),
  unique (file_id, version)
);

create index idx_amuxc_file_versions_file
  on public.amuxc_file_versions (file_id, version desc);

comment on table public.amuxc_file_versions is
  'Append-only version chain. parent_version=current_version at time of complete, so cas conflicts surface as a 409 before this row is written.';

-- ===========================================================================
-- 5. amuxc_upload_sessions: prepare/complete bridge
-- ===========================================================================
create table public.amuxc_upload_sessions (
  id              uuid        primary key default gen_random_uuid(),
  team_id         uuid        not null references public.teams(id) on delete cascade,
  actor_id        uuid        not null references public.actors(id) on delete cascade,
  node_id         text,
  path            text        not null,
  parent_version  int         not null,
  content_hash    text        not null,
  size            bigint      not null check (size >= 0),
  oss_key         text        not null,
  status          text        not null default 'pending'
    check (status in ('pending', 'completed', 'abandoned')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index idx_amuxc_sessions_expires
  on public.amuxc_upload_sessions (expires_at);
create index idx_amuxc_sessions_team_status
  on public.amuxc_upload_sessions (team_id, status);

comment on table public.amuxc_upload_sessions is
  'Tracks in-flight uploads between /prepare and /complete. actor_id is the creator; /complete must verify caller.actor_id == session.actor_id.';

-- ===========================================================================
-- 6. Guard trigger: lock down sync waterline against authenticated writes
-- ===========================================================================
create or replace function app.guard_team_workspace_sync_fields()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- service_role can do anything; everything else is restricted.
  if current_setting('role', true) = 'service_role' then
    return new;
  end if;

  if new.sync_mode is distinct from old.sync_mode then
    raise exception 'team_workspace_config.sync_mode is service-role only'
      using errcode = '42501';
  end if;
  if new.oss_change_seq is distinct from old.oss_change_seq then
    raise exception 'team_workspace_config.oss_change_seq is service-role only'
      using errcode = '42501';
  end if;
  if new.litellm_team_id is distinct from old.litellm_team_id then
    raise exception 'team_workspace_config.litellm_team_id is service-role only'
      using errcode = '42501';
  end if;

  return new;
end
$$;

create trigger trg_team_workspace_config_guard
  before update on public.team_workspace_config
  for each row
  execute function app.guard_team_workspace_sync_fields();

comment on function app.guard_team_workspace_sync_fields() is
  'Enforces the §2.6 waterline invariant: sync_mode / oss_change_seq / litellm_team_id are mutable only by service_role (FC). Authenticated team members can update other columns.';

-- ===========================================================================
-- 7. RLS: team members SELECT only, all writes are service_role only
-- ===========================================================================
alter table public.amuxc_blobs           enable row level security;
alter table public.amuxc_files           enable row level security;
alter table public.amuxc_file_versions   enable row level security;
alter table public.amuxc_upload_sessions enable row level security;

-- Force RLS on table owner too, so service_role policies (and lack of write
-- policies for authenticated) are honored when running migrations/tests as
-- postgres.
alter table public.amuxc_blobs           force row level security;
alter table public.amuxc_files           force row level security;
alter table public.amuxc_file_versions   force row level security;
alter table public.amuxc_upload_sessions force row level security;

-- ---- SELECT: team members of the row's team -------------------------------
create policy amuxc_blobs_select_team_member
  on public.amuxc_blobs           for select to authenticated
  using (app.is_team_member(team_id));

create policy amuxc_files_select_team_member
  on public.amuxc_files           for select to authenticated
  using (app.is_team_member(team_id));

-- amuxc_file_versions has no team_id column; route through file_id.
create policy amuxc_file_versions_select_team_member
  on public.amuxc_file_versions   for select to authenticated
  using (exists (
    select 1 from public.amuxc_files f
     where f.id = amuxc_file_versions.file_id
       and app.is_team_member(f.team_id)
  ));

create policy amuxc_upload_sessions_select_team_member
  on public.amuxc_upload_sessions for select to authenticated
  using (app.is_team_member(team_id));

-- ---- service_role: bypass everything --------------------------------------
-- Authenticated has no INSERT/UPDATE/DELETE policy → all writes denied for
-- that role. service_role bypasses RLS, so it can do everything.

-- ---- Grants ---------------------------------------------------------------
revoke all on public.amuxc_blobs, public.amuxc_files,
              public.amuxc_file_versions, public.amuxc_upload_sessions
  from public, anon, authenticated;
grant select on public.amuxc_blobs, public.amuxc_files,
                public.amuxc_file_versions, public.amuxc_upload_sessions
  to authenticated;
grant all on public.amuxc_blobs, public.amuxc_files,
             public.amuxc_file_versions, public.amuxc_upload_sessions
  to service_role;

-- ===========================================================================
-- 8. Helper: actor_id_for_user_in_team
--    FC auth middleware calls this (via service-role) to resolve the caller's
--    actor_id for a given (user_id, team_id) pair without using auth.uid().
-- ===========================================================================
create or replace function public.actor_id_for_user_in_team(
  p_user_id uuid,
  p_team_id uuid
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id
    from public.actors
   where user_id  = p_user_id
     and team_id  = p_team_id
   limit 1;
$$;

comment on function public.actor_id_for_user_in_team(uuid, uuid) is
  'Resolves actor.id for a (user_id, team_id) pair. Used by FC /sync/* auth middleware (service_role) where auth.uid() is not available. Returns NULL if the user is not a member of the team.';

-- Grant execution to service_role only; authenticated callers should use
-- app.current_actor_id_for_team() which relies on auth.uid().
revoke all on function public.actor_id_for_user_in_team(uuid, uuid) from public, anon, authenticated;
grant execute on function public.actor_id_for_user_in_team(uuid, uuid) to service_role;

-- ===========================================================================
-- 9. amuxc_complete_upload — atomic CAS upload-complete transaction
--
-- Implements spec §3.3 waterline invariant:
--   team_workspace_config update MUST be the first write in the transaction.
--
-- Returns: TABLE(version int, content_hash text, change_seq bigint)
-- Raises:
--   P0409 with hint JSON { remote_version, remote_hash } on CAS mismatch
--   P0403 on actor/session ownership mismatch
--   P0410 on expired or non-pending session
-- ===========================================================================
create or replace function public.amuxc_complete_upload(
  p_session_id uuid,
  p_actor_id   uuid
)
returns table(version int, content_hash text, change_seq bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session   public.amuxc_upload_sessions%rowtype;
  v_file      public.amuxc_files%rowtype;
  v_seq       bigint;
  v_new_ver   int;
begin
  -- Lock and read session
  select * into v_session
    from public.amuxc_upload_sessions
   where id = p_session_id
   for update;

  if not found then
    raise exception 'session not found' using errcode = 'P0404';
  end if;
  if v_session.actor_id <> p_actor_id then
    raise exception 'session does not belong to caller' using errcode = 'P0403';
  end if;
  if v_session.status <> 'pending' then
    raise exception 'session is %', v_session.status using errcode = 'P0410';
  end if;
  if v_session.expires_at < now() then
    raise exception 'session has expired' using errcode = 'P0410';
  end if;

  -- WATERLINE INVARIANT (§2.6): push seq FIRST, before any amuxc_files write.
  -- Any snapshot that can see oss_change_seq=N is guaranteed to also see
  -- all amuxc_files rows with change_seq<=N because they are committed in
  -- the same atomic transaction.
  update public.team_workspace_config
     set oss_change_seq = oss_change_seq + 1
   where team_id = v_session.team_id
  returning oss_change_seq into v_seq;

  if not found then
    raise exception 'team_workspace_config row missing for team %', v_session.team_id;
  end if;

  -- Ensure file row exists (upsert the pointer row)
  insert into public.amuxc_files (team_id, path, updated_by)
    values (v_session.team_id, v_session.path, p_actor_id)
  on conflict (team_id, path) do nothing;

  -- Lock file row
  select * into v_file
    from public.amuxc_files
   where team_id = v_session.team_id
     and path    = v_session.path
   for update;

  -- CAS check
  if v_file.current_version <> v_session.parent_version then
    raise exception 'cas-mismatch'
      using errcode = 'P0409',
            hint    = json_build_object(
                        'remote_version', v_file.current_version,
                        'remote_hash',    v_file.content_hash
                      )::text;
  end if;

  v_new_ver := v_file.current_version + 1;

  -- Mark blob verified (table-qualify to avoid PL/pgSQL ambiguity with local var)
  update public.amuxc_blobs b
     set verified = true
   where b.team_id      = v_session.team_id
     and b.content_hash = v_session.content_hash;

  -- Append version record
  insert into public.amuxc_file_versions
    (file_id, version, parent_version, content_hash, size, deleted,
     created_by, created_by_node_id)
  values
    (v_file.id, v_new_ver, v_session.parent_version, v_session.content_hash,
     v_session.size, false, p_actor_id, v_session.node_id);

  -- Advance file pointer
  update public.amuxc_files
     set current_version = v_new_ver,
         content_hash    = v_session.content_hash,
         size            = v_session.size,
         deleted         = false,
         change_seq      = v_seq,
         updated_by      = p_actor_id,
         updated_at      = now()
   where id = v_file.id;

  -- Mark session completed
  update public.amuxc_upload_sessions
     set status = 'completed'
   where id = p_session_id;

  return query select v_new_ver, v_session.content_hash, v_seq;
end;
$$;

comment on function public.amuxc_complete_upload(uuid, uuid) is
  'Atomic CAS upload-complete per spec §3.3. Waterline invariant: team_workspace_config.oss_change_seq is incremented BEFORE any amuxc_files write. Raises P0409 on CAS conflict, P0403 on ownership mismatch, P0410 on expired/non-pending session.';

revoke all on function public.amuxc_complete_upload(uuid, uuid) from public, anon, authenticated;
grant execute on function public.amuxc_complete_upload(uuid, uuid) to service_role;

-- ===========================================================================
-- 10. amuxc_complete_delete — atomic delete tombstone transaction
--
-- Same waterline invariant as amuxc_complete_upload.
-- Writes a tombstone version (content_hash=null, deleted=true).
--
-- Returns: TABLE(version int, change_seq bigint)
-- Raises:  P0409 on CAS mismatch, P0404 if file not found
-- ===========================================================================
create or replace function public.amuxc_complete_delete(
  p_team_id        uuid,
  p_path           text,
  p_parent_version int,
  p_actor_id       uuid,
  p_node_id        text default null
)
returns table(version int, change_seq bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_file    public.amuxc_files%rowtype;
  v_seq     bigint;
  v_new_ver int;
begin
  -- WATERLINE INVARIANT (§2.6): push seq FIRST.
  update public.team_workspace_config
     set oss_change_seq = oss_change_seq + 1
   where team_id = p_team_id
  returning oss_change_seq into v_seq;

  if not found then
    raise exception 'team_workspace_config row missing for team %', p_team_id;
  end if;

  -- Lock file row
  select * into v_file
    from public.amuxc_files
   where team_id = p_team_id
     and path    = p_path
   for update;

  if not found then
    raise exception 'file not found: %', p_path using errcode = 'P0404';
  end if;

  -- CAS check
  if v_file.current_version <> p_parent_version then
    raise exception 'cas-mismatch'
      using errcode = 'P0409',
            hint    = json_build_object(
                        'remote_version', v_file.current_version,
                        'remote_hash',    v_file.content_hash
                      )::text;
  end if;

  v_new_ver := v_file.current_version + 1;

  -- Append tombstone version record
  insert into public.amuxc_file_versions
    (file_id, version, parent_version, content_hash, size, deleted,
     created_by, created_by_node_id)
  values
    (v_file.id, v_new_ver, p_parent_version, null, 0, true, p_actor_id, p_node_id);

  -- Mark file as deleted and advance pointer
  update public.amuxc_files
     set current_version = v_new_ver,
         content_hash    = null,
         size            = 0,
         deleted         = true,
         change_seq      = v_seq,
         updated_by      = p_actor_id,
         updated_at      = now()
   where id = v_file.id;

  return query select v_new_ver, v_seq;
end;
$$;

comment on function public.amuxc_complete_delete(uuid, text, int, uuid, text) is
  'Atomic delete tombstone per spec §3.5. Same waterline invariant as amuxc_complete_upload. Raises P0409 on CAS conflict, P0404 if file not found.';

revoke all on function public.amuxc_complete_delete(uuid, text, int, uuid, text) from public, anon, authenticated;
grant execute on function public.amuxc_complete_delete(uuid, text, int, uuid, text) to service_role;

commit;
