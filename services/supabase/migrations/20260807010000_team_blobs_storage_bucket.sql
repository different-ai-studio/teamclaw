-- Team file-sync blobs move from Alibaba OSS to Supabase Storage.
-- See docs/plans/2026-08-07-knowledge-storage-sync.md — amuxc_blobs stays the
-- dedup/bookkeeping table; oss_key now holds this bucket's object path.
--
-- Separate from `team-skills` on purpose: same signing code, different
-- lifecycle (sync blobs are GC'd by cron.ts when orphaned, skill packages are
-- not), so keeping the buckets apart keeps a future policy change on one from
-- reaching the other.
--
-- Private bucket: all access goes through signed URLs minted by FC's
-- service-role client (services/fc/src/lib/team-blob-storage.ts), so no
-- authenticated/anon RLS policies are added — the default deny applies.
insert into storage.buckets (id, name, public)
values ('team-blobs', 'team-blobs', false)
on conflict (id) do nothing;
