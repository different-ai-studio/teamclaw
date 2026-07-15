-- 2026-05-16: support external IM actors and session binding URIs for gateway port.

-- actors: allow actor_type='external'; require source + source_id when type=external.
alter table public.actors
  drop constraint actors_actor_type_check;
alter table public.actors
  add constraint actors_actor_type_check
    check (actor_type in ('member', 'agent', 'external'));

alter table public.actors
  add column source text,
  add column source_id text;

alter table public.actors
  add constraint actors_external_has_source
    check ((actor_type = 'external') = (source is not null and source_id is not null));

create unique index actors_team_source_id_uq
  on public.actors (team_id, source, source_id)
  where source is not null;

-- sessions: binding URI for gateway-originated sessions.
alter table public.sessions
  add column binding text;

create unique index sessions_team_binding_uq
  on public.sessions (team_id, binding)
  where binding is not null;
