begin;

select plan(3);

-- Two teams: actor A is a member of team 1, actor B is a member of team 2.
-- We will upload one "idea attachment" object under team 1's path and assert:
--   1. team 1 member CAN select it
--   2. team 2 member CANNOT select it
--   3. an authenticated outsider with no membership CANNOT select it

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

insert into public.teams (id, slug, name)
values
  ('01900000-0000-0000-0000-000000000001', 'idea-rls-team-a', 'Idea RLS Team A'),
  ('01900000-0000-0000-0000-000000000002', 'idea-rls-team-b', 'Idea RLS Team B');

insert into public.actors (id, team_id, actor_type, user_id, display_name)
values
  ('11900000-0000-0000-0000-000000000001',
   '01900000-0000-0000-0000-000000000001', 'member',
   '91900000-0000-0000-0000-000000000001', 'Team A Member'),
  ('11900000-0000-0000-0000-000000000002',
   '01900000-0000-0000-0000-000000000002', 'member',
   '91900000-0000-0000-0000-000000000002', 'Team B Member');

insert into public.members (id, status)
values
  ('11900000-0000-0000-0000-000000000001', 'active'),
  ('11900000-0000-0000-0000-000000000002', 'active');

insert into public.team_members (id, team_id, member_id, role)
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

-- 2. Team B member cannot SELECT team A's attachment.
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
  0,
  'team B member cannot select team A''s idea attachment'
);

-- 3. Authenticated outsider (no team membership) cannot SELECT.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '91900000-0000-0000-0000-000000000003';
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '91900000-0000-0000-0000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*)::int
     from storage.objects
    where bucket_id = 'attachments'
      and name = '01900000-0000-0000-0000-000000000001/ideas/aaaaaaaaaaaa1111/abcdef012345/photo.jpg'),
  0,
  'authenticated outsider cannot select an idea attachment'
);

select * from finish();

rollback;
