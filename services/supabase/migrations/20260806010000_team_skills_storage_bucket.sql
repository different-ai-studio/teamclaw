-- Team skill package blobs move from Alibaba OSS to Supabase Storage.
-- See docs/architecture/team-skills-registry.md — amuxc_blobs stays the
-- dedup/bookkeeping table; oss_key now holds this bucket's object path for
-- skill rows. Private bucket: all access goes through signed URLs minted by
-- FC's service-role client (services/fc/src/lib/skills-storage.ts), so no
-- authenticated/anon RLS policies are added — the default deny applies.
insert into storage.buckets (id, name, public)
values ('team-skills', 'team-skills', false)
on conflict (id) do nothing;
