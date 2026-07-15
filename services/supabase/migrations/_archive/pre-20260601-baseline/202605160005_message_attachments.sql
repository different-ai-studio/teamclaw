-- Attachments metadata for gateway-originated messages.
alter table public.messages
  add column attachments jsonb not null default '[]'::jsonb;
