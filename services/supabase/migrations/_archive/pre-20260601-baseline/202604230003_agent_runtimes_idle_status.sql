alter table public.agent_runtimes
  drop constraint if exists agent_runtimes_status_check;

alter table public.agent_runtimes
  add constraint agent_runtimes_status_check
  check (status in ('starting', 'running', 'idle', 'stopped', 'failed'));
