import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof makeDb>;

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof makeDb> | null = null;

function makeDb(sql: ReturnType<typeof postgres>) {
  return drizzle(sql, { schema });
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
  });
  _db = makeDb(_client);
  return _db;
}
