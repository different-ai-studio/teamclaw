-- New multi-agent flow stops writing primary_agent_id; participants live
-- in session_participants. Existing rows keep their value (read-only).
-- Column will be dropped in a follow-up migration once old sessions age out.

alter table public.sessions
  alter column primary_agent_id drop not null;
