insert into auth.users (
  id,
  aud,
  role,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '90000000-0000-0000-0000-000000000001',
    'authenticated',
    'authenticated',
    'alice@example.com',
    now(),
    '{}'::jsonb,
    '{"display_name":"Alice"}'::jsonb,
    now(),
    now()
  ),
  (
    '90000000-0000-0000-0000-000000000002',
    'authenticated',
    'authenticated',
    'carol@example.com',
    now(),
    '{}'::jsonb,
    '{"display_name":"Carol"}'::jsonb,
    now(),
    now()
  );

insert into public.teams (id, slug, name)
values ('00000000-0000-0000-0000-000000000001', 'core', 'Core Team');

insert into public.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'member', '90000000-0000-0000-0000-000000000001', 'Alice', now()),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'member', '90000000-0000-0000-0000-000000000002', 'Carol', now()),
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'agent', null, 'Builder', now());

insert into public.members (id, status)
values
  ('10000000-0000-0000-0000-000000000001', 'active'),
  ('10000000-0000-0000-0000-000000000002', 'active');

insert into public.team_members (team_id, member_id, role)
values
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'member');

insert into public.workspaces (id, team_id, created_by_member_id, agent_id, name, path)
values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'amux', '/workspaces/amux');

insert into public.agents (id, default_workspace_id, owner_member_id, visibility, agent_types, default_agent_type, capabilities, status)
values
  (
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'team',
    '["claude","codex","opencode"]'::jsonb,
    'claude',
    '{"supported_backends":["claude","codex","opencode"]}'::jsonb,
    'active'
  );

insert into public.agent_member_access (agent_id, member_id, permission_level, granted_by_member_id)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'admin', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'view', '10000000-0000-0000-0000-000000000001');

insert into public.ideas (id, team_id, workspace_id, created_by_actor_id, title, description, status)
values
  (
    '40000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Model auth flow',
    'Design collaboration and authorization model',
    'open'
  );

insert into public.idea_external_refs (idea_id, provider, external_id, external_key, external_url, linked_by_actor_id)
values
  (
    '40000000-0000-0000-0000-000000000001',
    'github',
    '12345',
    'GH-12345',
    'https://github.com/openbeta/amux/issues/12345',
    '10000000-0000-0000-0000-000000000001'
  );

insert into public.sessions (id, team_id, idea_id, created_by_actor_id, primary_agent_id, mode, title, summary, last_message_preview, last_message_at)
values
  (
    '50000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'collab',
    'Agent access review',
    'Alice chatting with Builder',
    'Carol joined with view-only access to Builder',
    now()
  );

insert into public.session_participants (session_id, actor_id, role)
values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'participant'),
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'agent');

insert into public.messages (team_id, session_id, sender_actor_id, kind, content)
values
  ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'text', 'Please help review the permission model.'),
  ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'text', 'I can respond to Alice.'),
  ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'text', 'I can follow the review, but only Alice should be able to drive Builder.');

insert into public.agent_runtimes (team_id, agent_id, session_id, workspace_id, backend_type, backend_session_id, status, current_model, last_seen_at)
values
  (
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'codex',
    'runtime-001',
    'running',
    'gpt-5.4',
    now()
  );
