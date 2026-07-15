-- 2026-05-17: make gateway message idempotency usable by PostgREST upsert.
--
-- PostgREST's `on_conflict=session_id,external_id` emits an ON CONFLICT
-- target without a predicate, so it cannot match the previous partial unique
-- index (`where external_id is not null`). A normal unique index still allows
-- multiple NULL external_id rows in Postgres, while allowing provider message
-- ids to dedupe correctly.

drop index if exists public.messages_session_external_id_uq;

create unique index messages_session_external_id_uq
  on public.messages (session_id, external_id);
