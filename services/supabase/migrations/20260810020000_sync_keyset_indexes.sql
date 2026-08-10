-- Indexes for the incremental-sync readers.
--
-- Every /v1/sync/* endpoint pages on (updated_at, id) ascending, filtered by its
-- owning key (team or session). Without a matching index the keyset buys
-- nothing: Postgres still reads every candidate row, applies the per-row RLS
-- predicate, and top-N sorts. Measured on the self-host box against 120k
-- sessions, `GET /v1/sync/sessions?limit=50` took 2.3s for a 50-row page:
--
--     Limit  (actual time=2304.409..2304.415 rows=50)
--       ->  Sort  (Sort Key: updated_at, id)  Sort Method: top-N heapsort
--             ->  Seq Scan on sessions  (actual rows=120004)
--                   Filter: (team_id = ... AND amux.is_team_member(team_id)
--                            AND (... OR amux.is_session_participant(id)))
--
-- With these, the scan walks the index in sort order and stops once the page is
-- full, so RLS runs on a page's worth of rows instead of the whole table.
--
-- Plain CREATE INDEX (not CONCURRENTLY): these tables are small on every
-- deployment today, and the self-host apply-migrations loop runs each file in a
-- transaction, where CONCURRENTLY is not allowed.
--
-- Idempotent: safe for the self-host apply-migrations loop to re-run.

-- GET /v1/sync/sessions
CREATE INDEX IF NOT EXISTS sessions_team_updated_idx
  ON amux.sessions (team_id, updated_at, id);

-- GET /v1/sync/messages
CREATE INDEX IF NOT EXISTS messages_session_updated_idx
  ON amux.messages (session_id, updated_at, id);

-- GET /v1/sync/session-participants
CREATE INDEX IF NOT EXISTS session_participants_session_updated_idx
  ON amux.session_participants (session_id, updated_at, id);

-- GET /v1/sync/ideas
CREATE INDEX IF NOT EXISTS ideas_team_updated_idx
  ON amux.ideas (team_id, updated_at, id);

-- GET /v1/sync/actor-directory. The endpoint reads the actor_directory view,
-- whose driving table is amux.actors filtered by team.
CREATE INDEX IF NOT EXISTS actors_team_updated_idx
  ON amux.actors (team_id, updated_at, id);
