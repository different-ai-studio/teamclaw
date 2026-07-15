-- 20260527000002_oss_sync_cleanup.sql
--
-- OSS Sync v3 cleanup jobs:
--   1. Every 15 minutes: mark abandoned upload sessions (status=pending and
--      expired) → status='abandoned'. Hard-delete abandoned rows older than 24h.
--   2. Once a day: GC orphan blobs that no amuxc_file_versions row references
--      and that are >7 days old (covers both verified=false stale prepares and
--      verified=true blobs whose file was deleted). Note: OSS object deletion
--      is OUT OF SCOPE for this migration — only DB rows here. A future FC
--      side-task can scan amuxc_blobs missing from amuxc_file_versions and
--      DELETE from OSS.
--
-- See docs/superpowers/specs/2026-05-27-oss-sync-redesign-design.md §5.3.

begin;

create extension if not exists pg_cron;

-- Abandon expired upload sessions.
create or replace function app.oss_sync_abandon_expired_sessions()
returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  update public.amuxc_upload_sessions
     set status = 'abandoned'
   where status = 'pending'
     and expires_at < now();

  delete from public.amuxc_upload_sessions
   where status = 'abandoned'
     and expires_at < now() - interval '24 hours';
end;
$$;

-- GC orphan blobs (DB rows only).
create or replace function app.oss_sync_gc_orphan_blobs()
returns int
language plpgsql security definer set search_path = public, auth as $$
declare
  v_deleted int;
begin
  with orphan as (
    select b.team_id, b.content_hash
      from public.amuxc_blobs b
     where b.created_at < now() - interval '7 days'
       and not exists (
         select 1 from public.amuxc_file_versions v
          join public.amuxc_files f on f.id = v.file_id
          where f.team_id = b.team_id
            and v.content_hash = b.content_hash
       )
  )
  delete from public.amuxc_blobs b
   using orphan
   where b.team_id = orphan.team_id
     and b.content_hash = orphan.content_hash;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Schedule (guarded: pg_cron may not be available in all environments).
do $guard$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'oss-sync-abandon-expired-sessions',
      '*/15 * * * *',
      'select app.oss_sync_abandon_expired_sessions()'
    );

    perform cron.schedule(
      'oss-sync-gc-orphan-blobs',
      '17 4 * * *',
      'select app.oss_sync_gc_orphan_blobs()'
    );
  end if;
end $guard$;

commit;
