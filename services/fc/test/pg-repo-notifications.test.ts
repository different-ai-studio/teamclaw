/**
 * pg-repo-notifications — pglite tests for NOTIFICATIONS + PRESENCE domain.
 *
 * Follows the same pattern as pg-repo-sessions.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers, sessions } from "../src/db/schema/index.js";

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedTeam(db: any) {
  const [t] = await db
    .insert(teams)
    .values({ name: "TestTeam", slug: `test-${Date.now()}-${Math.random()}` })
    .returning();
  return t;
}

async function seedActor(db: any, teamId: string, userId?: string) {
  const uid = userId ?? `user-${Math.random()}`;
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "Test Actor", userId: uid })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

async function seedSession(db: any, teamId: string) {
  const [s] = await db
    .insert(sessions)
    .values({ teamId, mode: "solo", title: "Test Session" })
    .returning();
  return s;
}

// ── getNotificationPrefs ──────────────────────────────────────────────────────

test("getNotificationPrefs returns null when no row exists", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  // No row yet → null, so clients fall back to their own DEFAULT_PREFS.
  const prefs = await repo.getNotificationPrefs();
  assert.equal(prefs, null);
});

// ── putNotificationPrefs ──────────────────────────────────────────────────────

test("putNotificationPrefs upserts and returns snake_case prefs incl. DND", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const input = {
    user_id: actor.userId,
    enabled: false,
    dnd_start_min: 1320,
    dnd_end_min: 480,
    dnd_tz: "Asia/Shanghai",
  };
  const out = await repo.putNotificationPrefs(input);
  assert.equal(out.user_id, actor.userId);
  assert.equal(out.enabled, false);
  assert.equal(out.dnd_start_min, 1320);
  assert.equal(out.dnd_end_min, 480);
  assert.equal(out.dnd_tz, "Asia/Shanghai");
});

test("putNotificationPrefs round-trips multiple upserts and preserves unset dnd_tz", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  await repo.putNotificationPrefs({ user_id: actor.userId, enabled: true, dnd_start_min: 60, dnd_end_min: 120, dnd_tz: "UTC" });
  // Second upsert omits dnd_tz → it must keep the previously persisted value.
  const out = await repo.putNotificationPrefs({ user_id: actor.userId, enabled: false, dnd_start_min: null, dnd_end_min: null });
  assert.equal(out.enabled, false);
  assert.equal(out.dnd_start_min, null);
  assert.equal(out.dnd_end_min, null);
  assert.equal(out.dnd_tz, "UTC", "dnd_tz must be preserved when not provided");
});

test("getNotificationPrefs reflects persisted enabled + DND after put", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  await repo.putNotificationPrefs({ user_id: actor.userId, enabled: false, dnd_start_min: 1320, dnd_end_min: 480, dnd_tz: "Asia/Tokyo" });
  const prefs = await repo.getNotificationPrefs();
  assert.ok(prefs, "prefs row must exist after put");
  assert.equal(prefs.enabled, false, "enabled must reflect persisted value");
  assert.equal(prefs.dnd_start_min, 1320, "dnd_start_min must be persisted");
  assert.equal(prefs.dnd_end_min, 480, "dnd_end_min must be persisted");
  assert.equal(prefs.dnd_tz, "Asia/Tokyo", "dnd_tz must be persisted");
});

// ── muteSession / unmuteSession / listMutedSessions ──────────────────────────

test("muteSession inserts a mute record without throwing", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  await repo.muteSession(session.id, { until: null });
});

test("listMutedSessions returns the muted session id", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  await repo.muteSession(session.id, { until: null });
  const out = await repo.listMutedSessions();
  assert.ok(Array.isArray(out.items));
  assert.ok(out.items.includes(session.id));
});

test("unmuteSession removes the mute record without throwing", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  await repo.muteSession(session.id, { until: null });
  await repo.unmuteSession(session.id);
  const out = await repo.listMutedSessions();
  assert.ok(!out.items.includes(session.id));
});

test("unmuteSession on non-muted session does not throw", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  await repo.unmuteSession(session.id); // should not throw
});

test("listMutedSessions is user-scoped (other user's mutes not visible)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actorA = await seedActor(db, team.id);
  const actorB = await seedActor(db, team.id);
  const session = await seedSession(db, team.id);

  const repoA = createPgBusinessRepository({ db, userId: actorA.userId });
  const repoB = createPgBusinessRepository({ db, userId: actorB.userId });

  await repoA.muteSession(session.id, { until: null });
  const outB = await repoB.listMutedSessions();
  assert.ok(!outB.items.includes(session.id), "user B should not see user A's mutes");
});

// ── registerDevicePushToken ───────────────────────────────────────────────────

test("registerDevicePushToken upserts without throwing", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  await repo.registerDevicePushToken({
    deviceId: "device-abc",
    platform: "ios",
    provider: "apns",
    token: "tok-1",
    appVersion: "1.2.3",
  });
});

test("registerDevicePushToken upserts on repeated call (no duplicate error)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const input = { deviceId: "device-abc", platform: "ios", provider: "apns", token: "tok-1" };
  await repo.registerDevicePushToken(input);
  await repo.registerDevicePushToken({ ...input, token: "tok-2" }); // upsert with new token
});

// ── writeForegroundPresence ───────────────────────────────────────────────────

test("writeForegroundPresence upserts without throwing", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  await repo.writeForegroundPresence({
    deviceId: "device-abc",
    foregroundUntil: new Date(Date.now() + 60_000).toISOString(),
  });
});

test("writeForegroundPresence upserts on repeated call (no duplicate error)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const base = { deviceId: "device-abc" };
  await repo.writeForegroundPresence({ ...base, foregroundUntil: new Date(Date.now() + 30_000).toISOString() });
  await repo.writeForegroundPresence({ ...base, foregroundUntil: new Date(Date.now() + 60_000).toISOString() });
});
