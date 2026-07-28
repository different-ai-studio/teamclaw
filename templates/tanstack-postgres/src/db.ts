import postgres from 'postgres'

// Per-app Postgres connection. The role behind DATABASE_URL has a pinned
// search_path to this app's own schema, so unqualified table names resolve
// there. DATABASE_URL is server-only (never VITE_-prefixed) — FC injects it as
// an environment variable on the function.
const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  // Fail loud on boot rather than producing confusing query errors later.
  throw new Error('DATABASE_URL is not set')
}

// Pooled client. On a warm FC instance the pool survives across requests.
export const sql = postgres(connectionString, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
})

// --- Schema -----------------------------------------------------------------
// SOURCE OF TRUTH: db/schema.sql. Keep this DDL in sync with that file. It is
// inlined here (rather than read from disk) so it is bundled into
// .output/server/index.mjs and readable at runtime under the FC custom runtime.
// The provisioner does NOT run app migrations — the app creates its own schema
// on first boot. The DDL is idempotent (create table if not exists).
const SCHEMA_SQL = `
create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  created_at timestamptz not null default now()
);
`

let schemaReady: Promise<void> | undefined

// Idempotent, runs at most once per process. Awaited by loaders/actions before
// touching the items table so the very first request after a cold start works.
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = sql.unsafe(SCHEMA_SQL).then(() => undefined)
  }
  return schemaReady
}
