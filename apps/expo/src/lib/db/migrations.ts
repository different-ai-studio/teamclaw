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
