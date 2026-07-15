import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../../src/db/schema/index.js";

// Build a fresh in-process Postgres (pglite) with the generated drizzle
// migrations applied. Returns the drizzle db handle (same schema as runtime).
export async function makeTestDb() {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  const migDir = join(dirname(fileURLToPath(import.meta.url)), "../../src/db/migrations");
  let files: string[] = [];
  try { files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort(); } catch { files = []; }
  for (const f of files) {
    const sql = readFileSync(join(migDir, f), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await pg.exec(s);
    }
  }
  // Cast to any so callers can use the db handle without fighting
  // PgliteDatabase vs PostgresJsDatabase type variance
  return { db: db as any, pg };
}
