import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProvisionStatements } from "../../src/lib/provisioning/app-postgres.js";
import { PGlite } from "@electric-sql/pglite";
import { ensureAppSchema } from "../../src/lib/provisioning/app-postgres.js";
import { getAppsAdminExecutor } from "../../src/lib/provisioning/app-postgres.js";
import { appSchemaName } from "../../src/lib/provisioning/pg-name.js";

test("buildProvisionStatements throws on an unsafe schema name", () => {
  assert.throws(
    () =>
      buildProvisionStatements({
        schema: 'evil"; drop schema amux cascade; --',
        role: "app_ok",
        password: "pw",
      }),
    /unsafe postgres identifier/i,
  );
});

test("buildProvisionStatements throws on an unsafe role name", () => {
  assert.throws(
    () => buildProvisionStatements({ schema: "app_ok", role: "r-bad", password: "pw" }),
    /unsafe postgres identifier/i,
  );
});

test("buildProvisionStatements emits idempotent, schema-scoped DDL in order", () => {
  const stmts = buildProvisionStatements({ schema: "app_demo", role: "app_demo", password: "s3cret" });
  assert.equal(stmts[0], "create schema if not exists app_demo");
  // role created only if absent
  assert.match(stmts[1], /if not exists \(select 1 from pg_roles where rolname = 'app_demo'\)/);
  assert.match(stmts[1], /create role app_demo login password 's3cret'/);
  // grants are scoped to the app schema only — never to amux/public
  assert.ok(stmts.some((s) => s === "grant usage, create on schema app_demo to app_demo"));
  assert.ok(stmts.every((s) => !/\bamux\b|\bpublic\b/.test(s)));
  // search_path pinned
  assert.ok(stmts.includes("alter role app_demo set search_path = app_demo"));
});

test("buildProvisionStatements escapes single quotes in the password", () => {
  const stmts = buildProvisionStatements({ schema: "app_x", role: "app_x", password: "a'b" });
  assert.match(stmts[1], /password 'a''b'/);
});

test("ensureAppSchema creates the schema and a scoped role on a real PG (pglite)", async () => {
  const pg = new PGlite();
  const exec = async (sql: string) => { await pg.exec(sql); };
  const appId = "3f1c9a2e-0000-4000-8000-000000000abc";
  const expectedSchema = appSchemaName("Demo App", appId);
  const conn = await ensureAppSchema(exec, {
    appId,
    slug: "Demo App",
    password: "p@ss'1",
    baseUrl: "postgres://app_user@host:5432/teamclaw_apps",
  });
  const schemas = await pg.query<{ schema_name: string }>(
    `select schema_name from information_schema.schemata where schema_name = '${expectedSchema}'`,
  );
  assert.equal(schemas.rows.length, 1);
  const roles = await pg.query<{ rolname: string }>(
    "select rolname from pg_roles where rolname = 'app_3f1c9a2e_0000_4000_8000_000000000abc'",
  );
  assert.equal(roles.rows.length, 1);
  assert.match(conn.connectionString, /app_3f1c9a2e_0000_4000_8000_000000000abc/);
  assert.match(
    conn.connectionString,
    new RegExp(`[?&]options=.*search_path%3D${expectedSchema}`),
  );
});

test("ensureAppSchema is safe to run twice (idempotent re-deploy)", async () => {
  const pg = new PGlite();
  const exec = async (sql: string) => { await pg.exec(sql); };
  const params = {
    appId: "3f1c9a2e-0000-4000-8000-000000000abc",
    slug: "Demo App",
    password: "p@ss'1",
    baseUrl: "postgres://host:5432/teamclaw_apps",
  };
  await ensureAppSchema(exec, params);
  await ensureAppSchema(exec, params);
  const roles = await pg.query<{ n: number }>(
    "select count(*)::int as n from pg_roles where rolname = 'app_3f1c9a2e_0000_4000_8000_000000000abc'",
  );
  assert.equal(roles.rows[0].n, 1);
});

test("getAppsAdminExecutor throws a clear error when APPS_DB_ADMIN_URL is unset", () => {
  const prev = process.env.APPS_DB_ADMIN_URL;
  delete process.env.APPS_DB_ADMIN_URL;
  try {
    assert.throws(() => getAppsAdminExecutor(), /APPS_DB_ADMIN_URL is not set/);
  } finally {
    if (prev !== undefined) process.env.APPS_DB_ADMIN_URL = prev;
  }
});
