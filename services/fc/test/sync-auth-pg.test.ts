// test/sync-auth-pg.test.ts
// Tests for the BACKEND_KIND=postgres path in sync-auth.ts.
// Uses a pglite in-memory DB and an injected verify stub so no network calls.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import { makeTestDb } from "./db/pglite.js";
import { teams, actors, members, teamMembers } from "../src/db/schema/index.js";
import { authenticateSyncCall, authenticateJwtOnly } from "../src/lib/sync-auth.js";

const BASE = "https://cloud.ucar.cc";

// ---------------------------------------------------------------------------
// Key setup
// ---------------------------------------------------------------------------

async function makeKeyset() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid";
  jwk.alg = "ES256";
  const keyset = createLocalJWKSet({ keys: [jwk] });

  async function sign(sub: string) {
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setIssuer(BASE)
      .setAudience(BASE)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  return { keyset, sign };
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let db: any;
let teamId: string;
const userId = "user-pg-sync-test";
let actorId: string;
let keyset: JWTVerifyGetKey;
let sign: (sub: string) => Promise<string>;

// Build a verifyToken fn backed by our local keyset
function makeVerifyFn(ks: JWTVerifyGetKey) {
  return async (token: string) => {
    const { verifyAccessToken } = await import("../src/auth/verify.js");
    return verifyAccessToken(token, { keyset: ks, baseURL: BASE });
  };
}

// ---------------------------------------------------------------------------
// Force BACKEND_KIND=postgres for all tests; restore after
// ---------------------------------------------------------------------------

const origBackendKind = process.env.BACKEND_KIND;

before(async () => {
  process.env.BACKEND_KIND = "postgres";

  // Build keyset
  ({ keyset, sign } = await makeKeyset());

  // Build db with a seeded team + actor
  const result = await makeTestDb();
  db = result.db;

  const [team] = await db.insert(teams).values({ name: "PG Sync Team", slug: "pg-sync-team" }).returning();
  teamId = team.id;

  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "Test User", userId })
    .returning();
  actorId = actor.id;
  await db.insert(members).values({ id: actorId, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actorId, role: "member" });
});

after(() => {
  if (origBackendKind === undefined) {
    delete process.env.BACKEND_KIND;
  } else {
    process.env.BACKEND_KIND = origBackendKind;
  }
});

// ---------------------------------------------------------------------------
// authenticateSyncCall — postgres path
// ---------------------------------------------------------------------------

test("pg: valid token + member → ok with correct ids", async () => {
  const token = await sign(userId);
  const deps = { verifyToken: makeVerifyFn(keyset), db };
  const r = await authenticateSyncCall({ headers: { authorization: `Bearer ${token}` }, teamId }, deps);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  assert.equal(r.userId, userId);
  assert.equal(r.teamId, teamId);
  assert.equal(r.actorId, actorId);
});

test("pg: valid token for non-member → 403", async () => {
  const token = await sign("user-not-in-team");
  const deps = { verifyToken: makeVerifyFn(keyset), db };
  const r = await authenticateSyncCall({ headers: { authorization: `Bearer ${token}` }, teamId }, deps);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("unreachable");
  assert.equal(r.status, 403);
  assert.match(r.error, /not a team member/i);
});

test("pg: bad token (verify throws) → 401", async () => {
  const { sign: signOther } = await makeKeyset(); // different keypair
  const token = await signOther(userId);
  const deps = { verifyToken: makeVerifyFn(keyset), db };
  const r = await authenticateSyncCall({ headers: { authorization: `Bearer ${token}` }, teamId }, deps);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("unreachable");
  assert.equal(r.status, 401);
  assert.match(r.error, /jwt invalid/i);
});

test("pg: missing bearer → 401", async () => {
  const deps = { verifyToken: makeVerifyFn(keyset), db };
  const r = await authenticateSyncCall({ headers: {}, teamId }, deps);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("unreachable");
  assert.equal(r.status, 401);
  assert.match(r.error, /missing/i);
});

// ---------------------------------------------------------------------------
// authenticateJwtOnly — postgres path
// ---------------------------------------------------------------------------

test("pg jwt-only: valid token → ok with userId", async () => {
  const token = await sign(userId);
  const deps = { verifyToken: makeVerifyFn(keyset), db };
  const r = await authenticateJwtOnly({ headers: { authorization: `Bearer ${token}` } }, deps);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("unreachable");
  assert.equal(r.userId, userId);
});

test("pg jwt-only: bad token → 401", async () => {
  const { sign: signOther } = await makeKeyset();
  const token = await signOther("someone");
  const deps = { verifyToken: makeVerifyFn(keyset), db };
  const r = await authenticateJwtOnly({ headers: { authorization: `Bearer ${token}` } }, deps);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("unreachable");
  assert.equal(r.status, 401);
});
