-- `device_id` is the daemon's MQTT device identifier — the UUID from
-- daemon.toml [device].id. It's a property of the daemon (= agent actor
-- with agent_kind='daemon'), not a per-session runtime detail.
-- iOS consumes this to route MQTT publishes at `amux/{device_id}/…`.
alter table public.agents add column if not exists device_id text;

create index if not exists agents_device_id_idx on public.agents(device_id);
