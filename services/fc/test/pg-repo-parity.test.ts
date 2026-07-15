import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";

// Guard against silent backend drift.
//
// FC has two interchangeable business-repo implementations behind
// BACKEND_KIND. Routes call `ctx.repository.<method>(...)`, so any method a
// route invokes that the Postgres repo does NOT expose is a latent HTTP 500
// under BACKEND_KIND=postgres (undefined is not a function).
//
// This test derives the REQUIRED method surface from the actual route call
// sites (the real 500 risk — not supabase-repo's full internal surface, which
// includes private helpers) and asserts pg-repo implements every one. It fails
// the moment a new `ctx.repository.foo(...)` route lands without a pg-repo
// counterpart — forcing parity at PR time instead of in production.

const here = dirname(fileURLToPath(import.meta.url));
const routesDir = join(here, "..", "src", "lib", "routes");

function repositoryMethodsCalledByRoutes(): Set<string> {
  const called = new Set<string>();
  // Matches `.repository.foo(` and `.repository?.foo(` — the only way routes
  // reach the business repo. Captures the method name.
  const re = /\brepository\??\.([A-Za-z0-9_]+)\s*\(/g;
  for (const file of readdirSync(routesDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(routesDir, file), "utf8");
    for (const m of src.matchAll(re)) called.add(m[1]);
  }
  return called;
}

function pgMethodKeys(): Set<string> {
  // Auth routes and business routes both reach the repo via `ctx.repository`,
  // but under BACKEND_KIND=postgres they bind to two different factories.
  // Union both surfaces.
  //
  // Business repo: instantiate (construction only wires lazy closures; the stub
  // db is never queried).
  const business = createPgBusinessRepository({ db: {} as any });
  const keys = new Set(
    Object.keys(business).filter((k) => typeof (business as any)[k] === "function"),
  );
  // Auth repo (createPgAuthRepository): NOT instantiated — its module pulls in
  // better-auth, whose jose peer is version-sensitive and cannot always load in
  // a bare test env. Its method surface is stable, so we parse the method names
  // statically from source: `    async foo(` or `    foo(` at the returned
  // object's indent. Over-capturing a non-method here can only mask an auth-repo
  // gap (out of scope for this business-repo drift guard); it never false-fails.
  const authSrc = readFileSync(join(here, "..", "src", "lib", "pg-repo", "auth.ts"), "utf8");
  for (const m of authSrc.matchAll(/^    (?:async )?([A-Za-z0-9_]+)\s*\(/gm)) {
    keys.add(m[1]);
  }
  return keys;
}

// Route-invoked methods that pg-repo intentionally does NOT implement as real
// logic. These MUST still be present as explicit ApiError(501) stubs (so they
// fail cleanly, not with a 500), which pgMethodKeys() counts as present — so
// this list should normally stay empty. Anything added here is a conscious
// "supabase-only feature" decision and needs a justification comment.
const ROUTE_METHODS_NOT_ON_PG = new Set<string>([]);

test("pg-repo implements every method the routes call (no silent 500 drift)", () => {
  const required = repositoryMethodsCalledByRoutes();
  const pg = pgMethodKeys();

  assert.ok(required.size > 20, `sanity: expected many route methods, got ${required.size}`);

  const missing = [...required].filter(
    (m) => !pg.has(m) && !ROUTE_METHODS_NOT_ON_PG.has(m),
  );

  assert.deepEqual(
    missing.sort(),
    [],
    `pg-repo is missing ${missing.length} route-invoked method(s): ${missing.join(", ")}. ` +
      `They would 500 under BACKEND_KIND=postgres. Implement them in src/lib/pg-repo/*.ts, ` +
      `or add an explicit ApiError(501) stub if genuinely supabase-only.`,
  );
});

test("ROUTE_METHODS_NOT_ON_PG allowlist has no stale entries", () => {
  const required = repositoryMethodsCalledByRoutes();
  const stale = [...ROUTE_METHODS_NOT_ON_PG].filter((m) => !required.has(m));
  assert.deepEqual(stale, [], `allowlist references non-route methods: ${stale.join(", ")}`);
});
