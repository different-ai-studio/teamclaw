/**
 * db-search-path.test.ts — pins the schema resolution order for every drizzle
 * query.
 *
 * Every table in `src/db/schema/` is declared with a bare `pgTable("name")`, so
 * the emitted SQL is unqualified and `search_path` alone decides what it finds.
 * The tables live in `amux`; the connecting role's stock default does not list
 * it. When that was the whole story, both FC timer tasks failed on every run
 * with `relation "amuxc_upload_sessions" does not exist` — for months, silently,
 * because nothing else on the deployment uses this client.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSearchPath } from "../src/db/client.js";

const schemas = () => resolveSearchPath().split(",").map((s) => s.trim());

test("amux is searched first — that is the whole point", () => {
  assert.equal(schemas()[0], "amux");
});

test("the stock Supabase schemas are kept, not replaced", () => {
  // `public` still holds tables this schema also names (members, permissions);
  // `auth` and `extensions` are GoTrue's tables and pgcrypto. Dropping any of
  // them would trade one set of missing relations for another.
  for (const schema of ["public", "auth", "extensions"]) {
    assert.ok(schemas().includes(schema), `${schema} must stay on the path`);
  }
});

test("no env var can move it", () => {
  // The FC deploy target rewrites its whole environment map, so a search_path
  // that lived in env would disappear on an unrelated deploy and put the cron
  // tasks back on the floor. It stays in git next to the migrations that decide
  // where the tables actually are.
  process.env.PG_SEARCH_PATH = "somewhere_else";
  try {
    assert.equal(schemas()[0], "amux");
  } finally {
    delete process.env.PG_SEARCH_PATH;
  }
});
