import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof makeDb>;

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof makeDb> | null = null;

function makeDb(sql: ReturnType<typeof postgres>) {
  return drizzle(sql, { schema });
}

/**
 * Where this connection looks for unqualified table names.
 *
 * Every table in `src/db/schema/` is declared with a bare `pgTable("name")`, so
 * the SQL drizzle emits is unqualified and resolution is entirely up to
 * `search_path`. The tables themselves live in `amux` — `move_teamclu_to_amux`
 * relocated them out of `public` — while the role we connect as carries the
 * stock Supabase default (`"$user", public, auth, extensions`). Nothing put
 * `amux` on that list, so every drizzle query against a relocated table failed
 * with `relation "…" does not exist`.
 *
 * That was not theoretical: it is why both FC timer tasks (`oss-abandon-sessions`
 * every 15 minutes, `oss-gc-blobs` daily) had failed on every single run since
 * the function was created, so expired upload sessions were never abandoned and
 * orphan blobs were never collected.
 *
 * `amux` is PREPENDED to the stock list rather than replacing it: `public` still
 * holds tables this schema also names (`members`, `permissions`), `auth` and
 * `extensions` are where Supabase keeps GoTrue's tables and pgcrypto. A
 * narrower path would trade one set of missing relations for another.
 *
 * Deliberately NOT an env var. It would have to be declared on both deploy
 * targets, and the FC one rewrites its whole environment map on every deploy —
 * so a path configured only in one machine's env file would vanish on the next
 * unrelated deploy and take the cron tasks down again, silently, exactly the way
 * they were already down. Where the tables live is a property of the migrations,
 * which are in git; this belongs in git with them.
 */
const SEARCH_PATH = "amux, public, auth, extensions";

/** Exported so the ordering above can be pinned by a test rather than by hope. */
export function resolveSearchPath(): string {
  return SEARCH_PATH;
}

// Module-level singleton. Serverless-safe defaults: small pool, short idle,
// prepare:false (proxy-compatible). Tune via env. Production: front with
// Alibaba RDS Proxy / PolarDB Proxy; this code only needs DATABASE_URL.
export function getDb(): Db {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  _client = postgres(url, {
    max: Number(process.env.PG_POOL_MAX ?? "1"),
    idle_timeout: Number(process.env.PG_IDLE_TIMEOUT ?? "20"),
    connect_timeout: Number(process.env.PG_CONNECT_TIMEOUT ?? "10"),
    prepare: false,
    // Sent in the startup packet, so it is set before the first query rather
    // than by a `SET` that a pooled connection could hand back without.
    connection: { search_path: resolveSearchPath() },
  });
  _db = makeDb(_client);
  return _db;
}
