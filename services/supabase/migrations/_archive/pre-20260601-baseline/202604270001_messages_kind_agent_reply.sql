alter table public.messages
  drop constraint if exists messages_kind_check;

alter table public.messages
  add constraint messages_kind_check
  check (kind in ('text', 'system', 'idea_event', 'agent_reply'));
