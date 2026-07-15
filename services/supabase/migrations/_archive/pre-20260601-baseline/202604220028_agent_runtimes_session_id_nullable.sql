-- daemon upserts an `agent_runtimes` row the moment an agent spawns, which
-- can be before any collab session is wired up (e.g. session-less one-shots
-- or legacy MQTT-first flows). Relax the NOT NULL so the row can live
-- without a session until one is attached.
alter table public.agent_runtimes alter column session_id drop not null;
