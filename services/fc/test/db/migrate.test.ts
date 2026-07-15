import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./pglite.js";
import { teams, actors, user, session } from "../../src/db/schema/index.js";

test("migrations apply on pglite and tables are usable", async () => {
  const { db } = await makeTestDb();
  const [t] = await db.insert(teams).values({ name: "Acme", slug: "acme" }).returning();
  assert.equal(t.name, "Acme");
  assert.equal(t.shareMode, null);
  assert.ok(t.id && t.createdAt);
});

test("better-auth tables apply on pglite", async () => {
  const { db } = await makeTestDb();
  const [u] = await db.insert(user).values({
    id: "u1",
    name: "U",
    email: "u@e.com",
    emailVerified: false,
  }).returning();
  assert.equal(u.id, "u1");
  await db.insert(session).values({
    id: "s1",
    userId: "u1",
    token: "tok",
    expiresAt: new Date(Date.now() + 3600_000),
  });
});

test("partial unique index allows multiple null-user actors in a team", async () => {
  const { db } = await makeTestDb();
  const [t] = await db.insert(teams).values({ name: "T", slug: "t" }).returning();
  await db.insert(actors).values({ teamId: t.id, actorType: "agent", displayName: "A1" });
  await db.insert(actors).values({ teamId: t.id, actorType: "agent", displayName: "A2" });
  const rows = await db.select().from(actors);
  assert.equal(rows.length, 2);
});
