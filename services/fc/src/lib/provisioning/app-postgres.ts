import postgres from "postgres";
import { appSchemaName, appRoleName } from "./pg-name.js";

const SAFE_IDENT = /^[a-z0-9_]+$/;

function assertSafe(ident: string): void {
  if (!SAFE_IDENT.test(ident)) {
    throw new Error(`unsafe postgres identifier: ${JSON.stringify(ident)}`);
  }
}

export interface ProvisionParams {
  schema: string; // already-sanitized schema name (see pg-name.ts)
  role: string; // already-sanitized role name
  password: string; // generated secret for the scoped login role
}

// Returns the ordered, idempotent DDL statements that create the per-app schema
// + a login role scoped to ONLY that schema. CREATE SCHEMA/ROLE cannot be
// parameterized, so identifiers are interpolated AFTER assertSafe(); the
// password is the only value-position datum and is single-quote-escaped.
export function buildProvisionStatements({ schema, role, password }: ProvisionParams): string[] {
  assertSafe(schema);
  assertSafe(role);
  const pw = password.replace(/'/g, "''");
  return [
    `create schema if not exists ${schema}`,
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname = '${role}') then
         create role ${role} login password '${pw}';
       end if;
     end $$`,
    `grant usage, create on schema ${schema} to ${role}`,
    `alter default privileges in schema ${schema} grant all on tables to ${role}`,
    `alter default privileges in schema ${schema} grant all on sequences to ${role}`,
    `grant all on all tables in schema ${schema} to ${role}`,
    `grant all on all sequences in schema ${schema} to ${role}`,
    `alter role ${role} set search_path = ${schema}`,
  ];
}

export type SqlExecutor = (sql: string) => Promise<void>;

export interface EnsureAppSchemaParams {
  appId: string;
  slug: string;
  password: string;
  // The teamclaw_apps base URL WITHOUT credentials/db-specific role, e.g.
  // postgres://host:5432/teamclaw_apps — used to compose the app's own
  // connection string (role + password + pinned search_path).
  baseUrl: string;
}

export interface AppConnection {
  schema: string;
  role: string;
  connectionString: string;
}

export async function ensureAppSchema(
  exec: SqlExecutor,
  { appId, slug, password, baseUrl }: EnsureAppSchemaParams,
): Promise<AppConnection> {
  const schema = appSchemaName(slug, appId);
  const role = appRoleName(appId);
  for (const stmt of buildProvisionStatements({ schema, role, password })) {
    await exec(stmt);
  }
  const u = new URL(baseUrl);
  u.username = role;
  u.password = password;
  u.searchParams.set("options", `-c search_path=${schema}`);
  return { schema, role, connectionString: u.toString() };
}

let _adminSql: ReturnType<typeof postgres> | null = null;

// Dedicated admin connection to the teamclaw_apps database (NOT supabase_db).
// Mirrors db/client.ts serverless-safe defaults. Separate singleton so app
// provisioning never shares the control-plane pool.
export function getAppsAdminExecutor(): SqlExecutor {
  const url = process.env.APPS_DB_ADMIN_URL;
  if (!url) throw new Error("APPS_DB_ADMIN_URL is not set");
  if (!_adminSql) {
    _adminSql = postgres(url, {
      max: Number(process.env.PG_POOL_MAX ?? "1"),
      idle_timeout: Number(process.env.PG_IDLE_TIMEOUT ?? "20"),
      connect_timeout: Number(process.env.PG_CONNECT_TIMEOUT ?? "10"),
      prepare: false,
    });
  }
  const sql = _adminSql;
  return async (statement: string) => {
    await sql.unsafe(statement);
  };
}
