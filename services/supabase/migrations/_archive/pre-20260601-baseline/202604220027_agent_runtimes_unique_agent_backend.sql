-- daemon upserts agent_runtimes with `on_conflict=agent_id,backend_session_id`.
-- That needs a matching unique index. `backend_session_id` is nullable, and
-- we want NULLs treated as equal so repeated inserts for a legacy/unknown
-- backend still collide on the agent row.
create unique index if not exists agent_runtimes_agent_backend_uniq
  on public.agent_runtimes(agent_id, backend_session_id)
  nulls not distinct;
