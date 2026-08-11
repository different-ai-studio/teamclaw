import { DatabaseSync } from "node:sqlite";

import { MIGRATIONS } from "../../lib/db/migrations";
import type { CacheDb } from "../../lib/db/local-cache";

/**
 * A real SQLite database for tests, driven through the same `CacheDb` surface
 * the app uses against expo-sqlite.
 *
 * Node ships SQLite, so the cache layer can be tested against actual SQL —
 * schema, constraints, ordering and all — rather than a hand-rolled fake that
 * pattern-matches statements and drifts from the real engine. The migrations
 * are the app's own, so a broken migration fails here too.
 */
export function createMemoryCacheDb(): CacheDb & { close: () => void } {
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) {
    db.exec(migration.up);
  }
  return {
    async runAsync(sql: string, ...params: unknown[]) {
      db.prepare(sql).run(...(params as never[]));
    },
    async getAllAsync(sql: string, ...params: unknown[]) {
      return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    },
    async withTransactionAsync(task: () => Promise<void>) {
      db.exec("BEGIN");
      try {
        await task();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
