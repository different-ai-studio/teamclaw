begin;

select plan(4);

select has_column('amux', 'idea_activities', 'attachment_urls',
                  'idea_activities.attachment_urls exists');
select col_type_is('amux', 'idea_activities', 'attachment_urls', 'text[]',
                   'idea_activities.attachment_urls is text[]');
select col_not_null('amux', 'idea_activities', 'attachment_urls',
                    'idea_activities.attachment_urls is NOT NULL');

insert into auth.users (id, email, aud, role, instance_id)
values (
  '91800000-0000-0000-0000-000000000001',
  'idea-activity-attachments@example.com',
  'authenticated',
  'authenticated',
  '00000000-0000-0000-0000-000000000000'
);

insert into amux.teams (id, slug, name)
values (
  '01800000-0000-0000-0000-000000000001',
  'idea-activity-attachments-team',
  'Idea Activity Attachments Team'
);

insert into amux.actors (id, team_id, actor_type, user_id, display_name)
values (
  '11800000-0000-0000-0000-000000000001',
  '01800000-0000-0000-0000-000000000001',
  'member',
  '91800000-0000-0000-0000-000000000001',
  'Idea Activity Attachments Member'
);

insert into amux.members (id, status)
values (
  '11800000-0000-0000-0000-000000000001',
  'active'
);

insert into amux.team_members (id, team_id, member_id, role)
values (
  '21800000-0000-0000-0000-000000000001',
  '01800000-0000-0000-0000-000000000001',
  '11800000-0000-0000-0000-000000000001',
  'member'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '91800000-0000-0000-0000-000000000001';
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    '91800000-0000-0000-0000-000000000001',
    'role',
    'authenticated'
  )::text,
  true
);

create temporary table created_idea as
select *
from amux.create_idea(
  '01800000-0000-0000-0000-000000000001',
  'Image attachment idea'
);

create temporary table created_activity as
select *
from amux.create_idea_activity(
  (select id from created_idea),
  'progress',
  'Attached screenshots.',
  '{}'::jsonb,
  array[
    'https://storage.example.com/one.jpg',
    'https://storage.example.com/two.png'
  ]::text[]
);

select is(
  (select attachment_urls from created_activity),
  array[
    'https://storage.example.com/one.jpg',
    'https://storage.example.com/two.png'
  ]::text[],
  'create_idea_activity stores attachment urls'
);

select * from finish();

rollback;
