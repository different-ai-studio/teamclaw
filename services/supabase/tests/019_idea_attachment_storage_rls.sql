begin;

select plan(3);

-- The `attachments` bucket is public on purpose, and this file asserts that
-- model rather than the team isolation it originally claimed.
--
-- 20260530000001_attachments_bucket_public.sql flipped the bucket to public
-- when iOS dropped the Supabase SDK: attachment URLs are persisted into message
-- content and idea.attachment_urls, and every client renders them as a plain
-- image fetch with no bearer. The confidentiality model is the unguessable path
-- (`<team>/<session>/<uuid>/<file>`), the same capability model as `avatars`.
-- `attachments_public_read` grants SELECT on the bucket to `public`, and
-- because permissive policies OR together, it also supersedes the older
-- `team_members_can_download_idea_attachments` policy that survives next to it.
--
-- So:
--   1. team 1 member CAN select it
--   2. an outsider CAN select it too -- public bucket, path is the capability
--   3. the private buckets are still private, which is where isolation lives

insert into auth.users (id, email, aud, role, instance_id)
values
  ('91900000-0000-0000-0000-000000000001',
   'idea-rls-member@example.com',  'authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000'),
  ('91900000-0000-0000-0000-000000000002',
   'idea-rls-other@example.com',   'authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000'),
  ('91900000-0000-0000-0000-000000000003',
   'idea-rls-outsider@example.com','authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name)
values
  ('01900000-0000-0000-0000-000000000001', 'idea-rls-team-a', 'Idea RLS Team A'),
  ('01900000-0000-0000-0000-000000000002', 'idea-rls-team-b', 'Idea RLS Team B');

insert into amux.actors (id, team_id, actor_type, user_id, display_name)
values
  ('11900000-0000-0000-0000-000000000001',
   '01900000-0000-0000-0000-000000000001', 'member',
   '91900000-0000-0000-0000-000000000001', 'Team A Member'),
  ('11900000-0000-0000-0000-000000000002',
   '01900000-0000-0000-0000-000000000002', 'member',
   '91900000-0000-0000-0000-000000000002', 'Team B Member');

insert into amux.members (id, status)
values
  ('11900000-0000-0000-0000-000000000001', 'active'),
  ('11900000-0000-0000-0000-000000000002', 'active');

insert into amux.team_members (id, team_id, member_id, role)
values
  ('21900000-0000-0000-0000-000000000001',
   '01900000-0000-0000-0000-000000000001',
   '11900000-0000-0000-0000-000000000001', 'member'),
  ('21900000-0000-0000-0000-000000000002',
   '01900000-0000-0000-0000-000000000002',
   '11900000-0000-0000-0000-000000000002', 'member');

-- Insert the storage object as the service role so we bypass the
-- upload policy and exercise only the SELECT policy under test.
insert into storage.objects (bucket_id, name, owner, metadata)
values (
  'attachments',
  '01900000-0000-0000-0000-000000000001/ideas/aaaaaaaaaaaa1111/abcdef012345/photo.jpg',
  null,
  '{}'::jsonb
);

-- 1. Team A member can SELECT.
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '91900000-0000-0000-0000-000000000001';
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '91900000-0000-0000-0000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*)::int
     from storage.objects
    where bucket_id = 'attachments'
      and name = '01900000-0000-0000-0000-000000000001/ideas/aaaaaaaaaaaa1111/abcdef012345/photo.jpg'),
  1,
  'team A member can select their team''s idea attachment'
);

-- 2. A member of another team reads it as well: the bucket is public.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '91900000-0000-0000-0000-000000000002';
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '91900000-0000-0000-0000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*)::int
     from storage.objects
    where bucket_id = 'attachments'
      and name = '01900000-0000-0000-0000-000000000001/ideas/aaaaaaaaaaaa1111/abcdef012345/photo.jpg'),
  1,
  'another team''s member also reads it: attachments is a public bucket'
);

-- 3. The public flag is scoped to the two capability-URL buckets. If a future
-- migration flips team-skills or team-blobs public, sync payloads and skill
-- bundles would become world-readable, and this is the assertion that fails.
reset role;

select results_eq(
  $$ select id, public from storage.buckets order by id $$,
  $$ values ('attachments'::text, true),
            ('avatars',           true),
            ('team-blobs',        false),
            ('team-skills',       false) $$,
  'only the capability-URL buckets are public'
);

select * from finish();

rollback;
