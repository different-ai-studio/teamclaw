/**
 * pg-business-factory-authz.test.ts
 *
 * ROOT-CAUSE (#1) regression suite: proves the postgres business-repo factory
 * actually verifies the bearer JWT and threads claims.sub → ctx.userId, and that
 * the identity-dependent repo methods (createShortcut / listSessions /
 * markSessionViewed) enforce authz off that resolved userId instead of trusting
 * client-supplied actor ids.
 *
 * Two layers are exercised:
 *   1. makeBusinessRepoFactory("postgres", { keyset }) — the JWT verification +
 *      userId resolution wiring (the crux). A local jose keyset (same pattern as
 *      auth-verify.test.ts) signs tokens; verifyOpts injects it.
 *   2. createPgBusinessRepository({ db, userId }) directly on a pglite db — the
 *      downstream authz behaviour once a userId is present.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { makeBusinessRepoFactory } from "../src/index.js";
import { teams, actors, members, teamMembers } from "../src/db/schema/index.js";

const BASE = "https://cloud.ucar.cc";

async function jwtSetup() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid"; jwk.alg = "ES256";
  const keyset = createLocalJWKSet({ keys: [jwk] });
  async function sign(sub: string) {
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setIssuer(BASE).setAudience(BASE).setIssuedAt().setExpirationTime("1h")
      .setSubject(sub)
      .sign(privateKey);
  }
  return { keyset, sign };
}

async function seedTeam(db: any) {
  const [t] = await db.insert(teams).values({ name: "T", slug: `t-${Math.random()}` }).returning();
  return t;
}
async function seedActor(db: any, teamId: string, userId = `user-${Math.random()}`) {
  const [a] = await db.insert(actors).values({ teamId, actorType: "member", displayName: "A", userId }).returning();
  await db.insert(members).values({ id: a.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: a.id, role: "member" });
  return a;
}

// ── Layer 1: factory verifies JWT and resolves userId ──────────────────────────

test("makeBusinessRepoFactory(postgres): a VALID JWT passes verification and reaches repo construction (userId resolved from sub)", async () => {
  const { keyset, sign } = await jwtSetup();
  const factory = makeBusinessRepoFactory("postgres", { keyset, baseURL: BASE });
  const token = await sign("user-abc");

  // getDb() requires DATABASE_URL; in the test env it is unset, so it throws
  // *after* the JWT is verified and claims.sub extracted. Reaching this throw is
  // the proof that verification succeeded and the factory proceeded to build the
  // repo with the resolved identity (the pre-fix code never verified at all).
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(
      () => Promise.resolve(factory({ accessToken: token })),
      /DATABASE_URL/i,
      "valid token should pass verify and then hit getDb()",
    );
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test("makeBusinessRepoFactory(postgres): a BAD JWT fails closed as 401 BEFORE touching the db", async () => {
  const { keyset } = await jwtSetup();
  const { sign: signOther } = await jwtSetup(); // different keypair → bad signature
  const factory = makeBusinessRepoFactory("postgres", { keyset, baseURL: BASE });
  const token = await signOther("user-evil");

  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL; // ensure a 401 (not a DATABASE_URL error) proves we stopped early
  try {
    await assert.rejects(
      () => Promise.resolve(factory({ accessToken: token })),
      (err: any) => err?.statusCode === 401 && err?.code === "invalid_token",
      "bad token must throw 401 invalid_token before getDb()",
    );
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

// ── Layer 2: downstream authz off the resolved ctx.userId ──────────────────────

test("createShortcut: resolves owner from ctx.userId membership (non-member → 403)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  // A user who is NOT a member of `team`.
  const repo = createPgBusinessRepository({ db, userId: "user-not-a-member" });
  await assert.rejects(
    () => repo.createShortcut({ teamId: team.id, kind: "link", label: "X", position: 0 }),
    /forbidden|not a member/i,
  );
});

test("createShortcut: client-supplied FOREIGN ownerActorId is rejected (cannot forge owner)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const me = await seedActor(db, team.id, "user-me");
  const someoneElse = await seedActor(db, team.id, "user-other");

  const repo = createPgBusinessRepository({ db, userId: "user-me" });
  // Caller tries to attribute the shortcut to another actor's id.
  await assert.rejects(
    () => repo.createShortcut({ teamId: team.id, kind: "link", label: "Forge", position: 0, ownerActorId: someoneElse.id }),
    /forbidden|does not match/i,
    "a foreign ownerActorId must be rejected, never trusted",
  );

  // The honest path (no ownerActorId, or ownerActorId == resolved) attributes to me.
  const sc = await repo.createShortcut({ teamId: team.id, kind: "link", label: "Mine", position: 0 });
  const { shortcuts } = await import("../src/db/schema/shortcuts.js");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(shortcuts).where(eq(shortcuts.id, sc.id));
  assert.equal(row.ownerMemberId, me.id, "owner must be the caller's resolved actor");
});

test("listSessions: works from ctx.userId with neither teamId nor actorId supplied", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const me = await seedActor(db, team.id, "user-me");
  const writer = createPgBusinessRepository({ db });
  await writer.createSession({ teamId: team.id, title: "S1", mode: "solo", participantActorIds: [me.id] });

  const repo = createPgBusinessRepository({ db, userId: "user-me" });
  const rows = await repo.listSessions({ limit: 50, cursor: null });
  assert.ok(rows.length >= 1, "should list the user's participating sessions");
  assert.ok(rows.every((r: any) => r.teamId === team.id));
});

test("listSessions: returns [] (fail closed) when there is no identity", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const me = await seedActor(db, team.id);
  const writer = createPgBusinessRepository({ db });
  await writer.createSession({ teamId: team.id, title: "Hidden", mode: "solo", participantActorIds: [me.id] });

  const repo = createPgBusinessRepository({ db }); // no userId
  const rows = await repo.listSessions({ limit: 50, cursor: null });
  assert.deepEqual(rows, [], "no identity → no sessions");
});

test("markSessionViewed: resolves the actor from ctx.userId (and fails closed without one)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const me = await seedActor(db, team.id, "user-me");
  const writer = createPgBusinessRepository({ db });
  const s = await writer.createSession({ teamId: team.id, title: "Mark", mode: "solo", participantActorIds: [me.id] });

  const repo = createPgBusinessRepository({ db, userId: "user-me" });
  await repo.markSessionViewed(s.id); // resolves to me, no throw

  const anon = createPgBusinessRepository({ db });
  await assert.rejects(() => anon.markSessionViewed(s.id), /missing_auth|cannot resolve actor/i);
});
