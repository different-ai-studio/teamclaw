import * as SQLite from "expo-sqlite";

import { runMigrations } from "./migrations";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("teamclaw.db");
      await db.execAsync("PRAGMA journal_mode = WAL;");
      await runMigrations(db);
      return db;
    })();
  }
  return dbPromise;
}

/** Test-only: reset the cached promise so each test opens fresh. */
export function __resetDbForTests(): void {
  dbPromise = null;
}
