begin;

select plan(6);

-- Seed: need at least one team row for the actor inserts below.
insert into public.teams (id, slug, name)
values ('00000000-0000-0000-0001-000000000001', 'gw-test-team', 'Gateway Test Team');

-- Column shape
select has_column('public', 'actors',   'source',   'actors has source column');
select has_column('public', 'actors',   'source_id', 'actors has source_id column');
select has_column('public', 'sessions', 'binding',   'sessions has binding column');

-- actor_type now allows external
select lives_ok($$
  insert into public.actors (team_id, actor_type, display_name, source, source_id)
  values (
    '00000000-0000-0000-0001-000000000001',
    'external', 'Bob (WeCom)', 'wecom', 'wecom-user:c1:bob'
  )
$$, 'can insert external actor with source');

-- external without source is rejected
select throws_ok($$
  insert into public.actors (team_id, actor_type, display_name)
  values ('00000000-0000-0000-0001-000000000001', 'external', 'Nope')
$$, '23514', null, 'external actor requires source/source_id');

-- (team, source, source_id) is unique
select throws_ok($$
  insert into public.actors (team_id, actor_type, display_name, source, source_id)
  values (
    '00000000-0000-0000-0001-000000000001',
    'external', 'Bob clone', 'wecom', 'wecom-user:c1:bob'
  )
$$, '23505', null, 'duplicate (team, source, source_id) is rejected');

select * from finish();
rollback;
