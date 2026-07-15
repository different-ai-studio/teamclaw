/**
 * cron.test.ts — pglite tests for OSS-sync cleanup cron functions and
 * timer-event dispatch in handler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import {
  ossSyncAbandonExpiredSessions,
  ossSyncGcOrphanBlobs,
  runCronTask,
} from "../src/lib/cron.js";
import {
  amuxcUploadSessions,
  amuxcBlobs,
  amuxcFileVersions,
  amuxcFiles,
} from "../src/db/schema/oss-sync.js";
import { teams, actors, members, teamMembers, teamWorkspaceConfig } from "../src/db/schema/index.js";
import { handler } from "../src/index.js";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------
let _slugCounter = 0;
async function seedTeam(db: any) {
  const slug = `cron-test-${Date.now()}-${_slugCounter++}`;
  const [t] = await db.insert(teams).values({ name: "CronTeam", slug }).returning();
  await db.insert(teamWorkspaceConfig).values({ teamId: t.id, syncMode: "oss", ossChangeSeq: 0 });
  return t;
}

async function seedActor(db: any, teamId: string) {
  const uid = `u-${Math.random()}`;
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "T", userId: uid })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "owner" });
  return actor;
}

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}
function fromNow(ms: number): Date {
  return new Date(Date.now() + ms);
}

// ---------------------------------------------------------------------------
// ossSyncAbandonExpiredSessions
// ---------------------------------------------------------------------------

test("ossSyncAbandonExpiredSessions: pending+expired → abandoned", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);

  // pending, already expired
  await db.insert(amuxcUploadSessions).values({
    teamId: team.id,
    actorId: actor.id,
    path: "/a.txt",
    parentVersion: 0,
    contentHash: "h1",
    size: 10,
    ossKey: "k1",
    status: "pending",
    expiresAt: ago(5_000),
  });

  // pending, not yet expired — should NOT be touched
  await db.insert(amuxcUploadSessions).values({
    teamId: team.id,
    actorId: actor.id,
    path: "/b.txt",
    parentVersion: 0,
    contentHash: "h2",
    size: 10,
    ossKey: "k2",
    status: "pending",
    expiresAt: fromNow(3_600_000),
  });

  const result = await ossSyncAbandonExpiredSessions(db);
  assert.equal(result.abandoned, 1, "one session should be abandoned");
  assert.equal(result.deleted, 0, "no sessions old enough to delete yet");

  const rows: any[] = await db.select().from(amuxcUploadSessions);
  const statuses = rows.map((r: any) => r.status).sort();
  assert.deepEqual(statuses, ["abandoned", "pending"]);
});

test("ossSyncAbandonExpiredSessions: abandoned+>24h expired → deleted", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);

  // abandoned, expired 25 hours ago → should be deleted
  await db.insert(amuxcUploadSessions).values({
    teamId: team.id,
    actorId: actor.id,
    path: "/c.txt",
    parentVersion: 0,
    contentHash: "h3",
    size: 10,
    ossKey: "k3",
    status: "abandoned",
    expiresAt: ago(25 * 3_600_000),
  });

  // abandoned, expired only 1 hour ago → NOT old enough to delete
  await db.insert(amuxcUploadSessions).values({
    teamId: team.id,
    actorId: actor.id,
    path: "/d.txt",
    parentVersion: 0,
    contentHash: "h4",
    size: 10,
    ossKey: "k4",
    status: "abandoned",
    expiresAt: ago(3_600_000),
  });

  const result = await ossSyncAbandonExpiredSessions(db);
  assert.equal(result.abandoned, 0, "no pending sessions to abandon");
  assert.equal(result.deleted, 1, "one old abandoned session should be deleted");

  const rows: any[] = await db.select().from(amuxcUploadSessions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "/d.txt");
});

// ---------------------------------------------------------------------------
// ossSyncGcOrphanBlobs
// ---------------------------------------------------------------------------

test("ossSyncGcOrphanBlobs: orphan blob >7d → deleted; referenced blob → kept", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);

  // Orphan blob: >7d old, no file version references it
  await db.insert(amuxcBlobs).values({
    teamId: team.id,
    contentHash: "orphan-hash",
    ossKey: "orphan-key",
    size: 100,
    verified: true,
    createdAt: ago(8 * 24 * 3_600_000),
  });

  // Recent orphan blob: >7d check should NOT delete it (createdAt < 7d ago is false)
  await db.insert(amuxcBlobs).values({
    teamId: team.id,
    contentHash: "recent-orphan-hash",
    ossKey: "recent-orphan-key",
    size: 100,
    verified: true,
    createdAt: ago(3 * 24 * 3_600_000), // only 3 days old
  });

  // Referenced blob: >7d old but has a file version → must be kept
  const refHash = "ref-hash";
  await db.insert(amuxcBlobs).values({
    teamId: team.id,
    contentHash: refHash,
    ossKey: "ref-key",
    size: 100,
    verified: true,
    createdAt: ago(10 * 24 * 3_600_000),
  });

  // Create file + version referencing ref-hash
  const [file] = await db
    .insert(amuxcFiles)
    .values({
      teamId: team.id,
      path: "/ref.txt",
      contentHash: refHash,
      size: 100,
      updatedBy: actor.id,
    })
    .returning();

  await db.insert(amuxcFileVersions).values({
    fileId: file.id,
    version: 1,
    parentVersion: 0,
    contentHash: refHash,
    size: 100,
    createdBy: actor.id,
  });

  const result = await ossSyncGcOrphanBlobs(db);
  assert.equal(result.deleted, 1, "only the old orphan should be deleted");

  const remaining: any[] = await db.select().from(amuxcBlobs);
  const hashes = remaining.map((r: any) => r.contentHash).sort();
  assert.deepEqual(hashes, ["recent-orphan-hash", "ref-hash"]);
});

// ---------------------------------------------------------------------------
// runCronTask dispatch
// ---------------------------------------------------------------------------

test("runCronTask: dispatches oss-abandon-sessions", async () => {
  const { db } = await makeTestDb();
  const result = await runCronTask(db, "oss-abandon-sessions");
  assert.equal(result.task, "oss-abandon-sessions");
  assert.ok("abandoned" in result.result);
  assert.ok("deleted" in result.result);
});

test("runCronTask: dispatches oss-gc-blobs", async () => {
  const { db } = await makeTestDb();
  const result = await runCronTask(db, "oss-gc-blobs");
  assert.equal(result.task, "oss-gc-blobs");
  assert.ok("deleted" in result.result);
});

test("runCronTask: throws on unknown task", async () => {
  const { db } = await makeTestDb();
  await assert.rejects(
    () => runCronTask(db, "unknown-task"),
    /Unknown cron task/
  );
});

// ---------------------------------------------------------------------------
// handler: timer-event discrimination
// ---------------------------------------------------------------------------

test("handler: timer event shape routes to cron (no rawPath/requestContext)", async () => {
  // We don't have a real DB in this unit test; we just want to verify that a
  // timer-shaped event doesn't reach the Hono app (which would return an HTTP
  // response shape with statusCode). Instead it should return a cron result
  // shape OR an error about DATABASE_URL/task — either way NOT { statusCode }.
  //
  // We construct a timer event with a known-bad task so runCronTask throws,
  // and verify the error bubbles as a thrown Error (not an HTTP 404/405 shape).
  const timerEvent = {
    triggerName: "oss-abandon-sessions",
    triggerTime: new Date().toISOString(),
    payload: '{"task":"__test_bad_task__"}',
  };

  // DATABASE_URL is not set in test env; getDb() will throw. That's fine —
  // we just need to confirm the timer path was entered (not the HTTP path).
  // HTTP path would return { statusCode: 404, body: ... }.
  let threw = false;
  let result: any = null;
  try {
    result = await handler(timerEvent, {});
  } catch (e: any) {
    threw = true;
    // Should be DATABASE_URL error or unknown task error, not an HTTP error
    assert.ok(
      e.message.includes("DATABASE_URL") || e.message.includes("Unknown cron task"),
      `Unexpected error: ${e.message}`
    );
  }

  // If it didn't throw, it returned a non-HTTP cron error object
  if (!threw) {
    assert.ok(result && typeof result === "object", "should return an object");
    // Should NOT look like an HTTP response
    assert.ok(!("statusCode" in result), "timer events must not produce HTTP statusCode");
  }
});

test("handler: HTTP event shape (with rawPath) is NOT treated as timer", async () => {
  // An OPTIONS request should return 204, not a cron result.
  const httpEvent = {
    rawPath: "/v1/teams",
    requestContext: { http: { method: "OPTIONS" } },
    headers: {},
    body: "",
    isBase64Encoded: false,
    queryStringParameters: {},
  };
  const res: any = await handler(httpEvent, {});
  assert.equal(res.statusCode, 204, "HTTP OPTIONS must still return 204");
});
