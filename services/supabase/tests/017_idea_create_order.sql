begin;

select plan(2);

insert into auth.users (id, email, aud, role, instance_id)
values (
  '91700000-0000-0000-0000-000000000001',
  'idea-order-member@example.com',
  'authenticated',
  'authenticated',
  '00000000-0000-0000-0000-000000000000'
);

insert into public.teams (id, slug, name)
values (
  '01700000-0000-0000-0000-000000000001',
  'idea-order-team',
  'Idea Order Team'
);

insert into public.actors (id, team_id, actor_type, user_id, display_name)
values (
  '11700000-0000-0000-0000-000000000001',
  '01700000-0000-0000-0000-000000000001',
  'member',
  '91700000-0000-0000-0000-000000000001',
  'Idea Order Member'
);

insert into public.members (id, status)
values (
  '11700000-0000-0000-0000-000000000001',
  'active'
);

insert into public.team_members (id, team_id, member_id, role)
values (
  '21700000-0000-0000-0000-000000000001',
  '01700000-0000-0000-0000-000000000001',
  '11700000-0000-0000-0000-000000000001',
  'member'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '91700000-0000-0000-0000-000000000001';
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',
    '91700000-0000-0000-0000-000000000001',
    'role',
    'authenticated'
  )::text,
  true
);

create temporary table created_ideas as
select *
from public.create_idea(
  '01700000-0000-0000-0000-000000000001',
  'First idea'
);

insert into created_ideas
select *
from public.create_idea(
  '01700000-0000-0000-0000-000000000001',
  'Second idea'
);

select is(
  (
    select sort_order
    from created_ideas
    where title = 'Second idea'
  ),
  (
    select sort_order - 1000
    from created_ideas
    where title = 'First idea'
  ),
  'newly created ideas receive the next top sort_order gap'
);

select is(
  array(
    select title
    from public.ideas
    where team_id = '01700000-0000-0000-0000-000000000001'
      and archived = false
    order by sort_order asc, updated_at desc
  ),
  array['Second idea', 'First idea'],
  'idea list order puts the newest created idea first'
);

select * from finish();

rollback;
