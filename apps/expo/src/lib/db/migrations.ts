export type MigratorDb = {
  execAsync: (sql: string) => Promise<unknown>;
  getFirstAsync: <T>(sql: string) => Promise<T | null>;
};

export type Migration = {
  version: number;
  up: string;
};

/**
 * Migrations are append-only and applied in order. `user_version` is bumped
 * to `MIGRATIONS.length` after the last one succeeds.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS outbox (
        message_id          TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL,
        team_id             TEXT NOT NULL,
        sender_actor_id     TEXT NOT NULL,
        content             TEXT NOT NULL,
        mention_actor_ids   TEXT NOT NULL DEFAULT '[]',
        reply_to_message_id TEXT,
        attachments         TEXT NOT NULL DEFAULT '[]',
        state               TEXT NOT NULL,
        attempt_count       INTEGER NOT NULL DEFAULT 0,
        last_error          TEXT,
        last_attempt_at     INTEGER,
        next_attempt_at     INTEGER,
        created_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(state, next_attempt_at);

      CREATE TABLE IF NOT EXISTS connected_agents (
        team_id          TEXT NOT NULL,
        agent_id         TEXT NOT NULL,
        display_name     TEXT NOT NULL,
        agent_kind       TEXT NOT NULL DEFAULT '',
        permission_level TEXT NOT NULL,
        visibility       TEXT NOT NULL,
        is_owner         INTEGER NOT NULL,
        device_id        TEXT,
        last_active_at   INTEGER,
        current_model    TEXT,
        status           INTEGER,
        updated_at       INTEGER NOT NULL,
        PRIMARY KEY (team_id, agent_id)
      );
    `,
  },
  {
    version: 2,
    up: `
      ALTER TABLE connected_agents ADD COLUMN agent_types TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE connected_agents ADD COLUMN default_agent_type TEXT;
    `,
  },
  {
    // The local cache iOS gets from SwiftData. Until now only the outbox and
    // the connected-agents list were durable; sessions and messages lived in
    // whole-blob AsyncStorage entries, and ideas, actors, workspaces and
    // shortcuts were not cached at all — those screens came up empty offline
    // where iOS shows last-known state.
    //
    // Rows are keyed by their server id and scoped by team, so a team switch
    // reads its own cache rather than clearing a shared one. `updated_at`
    // carries the server's timestamp where there is one, for staleness checks
    // and ordering; `cached_at` is local and only ever used for eviction.
    version: 3,
    up: `
      CREATE TABLE IF NOT EXISTS cached_sessions (
        session_id           TEXT PRIMARY KEY,
        team_id              TEXT NOT NULL,
        title                TEXT NOT NULL DEFAULT '',
        summary              TEXT NOT NULL DEFAULT '',
        participant_count    INTEGER NOT NULL DEFAULT 0,
        participant_actor_ids TEXT NOT NULL DEFAULT '[]',
        last_message_preview TEXT NOT NULL DEFAULT '',
        last_message_at      TEXT NOT NULL DEFAULT '',
        created_at           TEXT NOT NULL DEFAULT '',
        created_by           TEXT NOT NULL DEFAULT '',
        has_unread           INTEGER NOT NULL DEFAULT 0,
        cached_at            INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cached_sessions_team
        ON cached_sessions(team_id, last_message_at DESC);

      CREATE TABLE IF NOT EXISTS cached_messages (
        message_id          TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL,
        team_id             TEXT NOT NULL,
        sender_actor_id     TEXT NOT NULL DEFAULT '',
        kind                TEXT NOT NULL DEFAULT 'text',
        content             TEXT NOT NULL DEFAULT '',
        model               TEXT NOT NULL DEFAULT '',
        turn_id             TEXT NOT NULL DEFAULT '',
        reply_to_message_id TEXT NOT NULL DEFAULT '',
        metadata            TEXT,
        attachments         TEXT NOT NULL DEFAULT '[]',
        created_at          TEXT NOT NULL DEFAULT '',
        cached_at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cached_messages_session
        ON cached_messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS cached_ideas (
        idea_id              TEXT PRIMARY KEY,
        team_id              TEXT NOT NULL,
        workspace_id         TEXT,
        workspace_name       TEXT,
        created_by_actor_id  TEXT,
        title                TEXT NOT NULL DEFAULT '',
        description          TEXT NOT NULL DEFAULT '',
        status               TEXT NOT NULL DEFAULT 'open',
        archived             INTEGER NOT NULL DEFAULT 0,
        sort_order           INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL DEFAULT '',
        updated_at           TEXT NOT NULL DEFAULT '',
        cached_at            INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cached_ideas_team ON cached_ideas(team_id, archived);

      CREATE TABLE IF NOT EXISTS cached_actors (
        actor_id            TEXT PRIMARY KEY,
        team_id             TEXT NOT NULL,
        actor_type          TEXT NOT NULL DEFAULT 'member',
        display_name        TEXT NOT NULL DEFAULT '',
        role                TEXT,
        last_active_at      TEXT,
        avatar_url          TEXT,
        agent_types         TEXT NOT NULL DEFAULT '[]',
        default_agent_type  TEXT,
        default_workspace_id TEXT,
        owner_member_id     TEXT,
        visibility          TEXT,
        agent_kind          TEXT,
        member_status       TEXT,
        agent_status        TEXT,
        email               TEXT,
        phone               TEXT,
        created_at          TEXT,
        cached_at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cached_actors_team ON cached_actors(team_id, display_name);

      CREATE TABLE IF NOT EXISTS cached_workspaces (
        workspace_id TEXT PRIMARY KEY,
        team_id      TEXT NOT NULL,
        name         TEXT NOT NULL DEFAULT '',
        path         TEXT,
        agent_id     TEXT,
        archived     INTEGER NOT NULL DEFAULT 0,
        cached_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cached_workspaces_team ON cached_workspaces(team_id, name);

      CREATE TABLE IF NOT EXISTS cached_shortcuts (
        shortcut_id TEXT PRIMARY KEY,
        team_id     TEXT NOT NULL,
        scope       TEXT NOT NULL DEFAULT '',
        label       TEXT NOT NULL DEFAULT '',
        icon        TEXT,
        parent_id   TEXT,
        target      TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        cached_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cached_shortcuts_team ON cached_shortcuts(team_id, sort_order);
    `,
  },
];

export async function runMigrations(db: MigratorDb): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>(
    "PRAGMA user_version;",
  );
  const current = row?.user_version ?? 0;
  let applied = current;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    await db.execAsync(migration.up);
    applied = migration.version;
  }
  if (applied !== current) {
    await db.execAsync(`PRAGMA user_version = ${applied};`);
  }
}
