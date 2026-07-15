/**
 * pg-repo-telemetry — UUID-seed pglite tests for the TELEMETRY domain.
 *
 * Covers:
 *  - submitFeedback shape
 *  - listFeedback
 *  - deleteFeedback (no-throw)
 *  - submitSessionReport (no-throw)
 *  - submitSkillUsage (no-throw)
 *  - round-trip: submit feedback + reports + skill-usage then
 *    getTeamLeaderboard aggregates correctly (tokensUsed/costUsd/positive/
 *    negative/sessionCount/skillUsage/score)
 *  - listFeedbackSummary aggregates positive/negative/total per actor
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers, sessions } from "../src/db/schema/index.js";
import { actorClientVersions } from "../src/db/schema/telemetry.js";
import { eq } from "drizzle-orm";

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedTeam(db: any) {
  const [t] = await db
    .insert(teams)
    .values({ name: "TelTeam", slug: `tel-${Date.now()}-${Math.random()}` })
    .returning();
  return t;
}

async function seedActor(db: any, teamId: string, name = "Actor") {
  const userId = `user-${Math.random()}`;
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: name, userId })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

async function seedSession(db: any, teamId: string) {
  const [s] = await db
    .insert(sessions)
    .values({ teamId, title: "TelSession", mode: "solo" })
    .returning();
  return s;
}

// ── submitFeedback ─────────────────────────────────────────────────────────────

test("submitFeedback returns canonical shape", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, "Alpha");
  const session = await seedSession(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const messageId = crypto.randomUUID();

  const result = await repo.submitFeedback({
    messageId,
    actorId: actor.id,
    teamId: team.id,
    sessionId: session.id,
    kind: "positive",
    starRating: 5,
    skill: null,
  });

  assert.equal(result.messageId, messageId);
  assert.equal(result.actorId, actor.id);
  assert.equal(result.kind, "positive");
});

test("submitFeedback upserts on actorId+messageId conflict", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, "Beta");
  const repo = createPgBusinessRepository({ db });
  const messageId = crypto.randomUUID();

  await repo.submitFeedback({ messageId, actorId: actor.id, teamId: team.id, sessionId: null, kind: "positive" });
  const result = await repo.submitFeedback({ messageId, actorId: actor.id, teamId: team.id, sessionId: null, kind: "negative" });

  assert.equal(result.kind, "negative");
});

// ── listFeedback ──────────────────────────────────────────────────────────────

test("listFeedback returns items for session", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = createPgBusinessRepository({ db });

  await repo.submitFeedback({ messageId: crypto.randomUUID(), actorId: actor.id, teamId: team.id, sessionId: session.id, kind: "positive" });
  await repo.submitFeedback({ messageId: crypto.randomUUID(), actorId: actor.id, teamId: team.id, sessionId: session.id, kind: "negative" });

  const { items } = await repo.listFeedback({ sessionId: session.id });
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 2);
});

test("listFeedback returns empty for unknown session", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });
  const { items } = await repo.listFeedback({ sessionId: crypto.randomUUID() });
  assert.deepEqual(items, []);
});

// ── deleteFeedback ────────────────────────────────────────────────────────────

test("deleteFeedback does not throw for existing or missing row", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const messageId = crypto.randomUUID();

  await repo.submitFeedback({ messageId, actorId: actor.id, teamId: team.id, sessionId: null, kind: "positive" });
  await assert.doesNotReject(() => repo.deleteFeedback(messageId, actor.id));
  // second delete (row gone) must not throw
  await assert.doesNotReject(() => repo.deleteFeedback(messageId, actor.id));
  // missing row entirely — no throw
  await assert.doesNotReject(() => repo.deleteFeedback(crypto.randomUUID(), actor.id));
});

// ── submitSessionReport ────────────────────────────────────────────────────────

test("submitSessionReport does not throw", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = createPgBusinessRepository({ db });

  await assert.doesNotReject(() =>
    repo.submitSessionReport({
      actorId: actor.id,
      teamId: team.id,
      sessionId: session.id,
      tokensUsed: 1000,
      costUsd: 0.05,
      model: "gpt-4",
      agentKind: "assistant",
      skillUsage: { search: 3, summarize: 1 },
    }),
  );
});

// ── submitSkillUsage ──────────────────────────────────────────────────────────

test("submitSkillUsage does not throw", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  await assert.doesNotReject(() =>
    repo.submitSkillUsage({
      actorId: actor.id,
      teamId: team.id,
      sessionId: null,
      skill: "search",
      count: 2,
    }),
  );
});

// ── Round-trip: getTeamLeaderboard ────────────────────────────────────────────

test("getTeamLeaderboard returns documented keys and aggregates correctly", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, "LeadActor");
  const session = await seedSession(db, team.id);
  const repo = createPgBusinessRepository({ db });

  // Submit 2 session reports: tokensUsed=1000+500=1500, costUsd=0.05+0.02=0.07
  await repo.submitSessionReport({
    actorId: actor.id,
    teamId: team.id,
    sessionId: session.id,
    tokensUsed: 1000,
    costUsd: 0.05,
    skillUsage: { search: 3 },
  });
  await repo.submitSessionReport({
    actorId: actor.id,
    teamId: team.id,
    sessionId: session.id,
    tokensUsed: 500,
    costUsd: 0.02,
    skillUsage: { summarize: 2 },
  });

  // Submit feedback: 2 positive, 1 negative
  await repo.submitFeedback({ messageId: crypto.randomUUID(), actorId: actor.id, teamId: team.id, sessionId: session.id, kind: "positive" });
  await repo.submitFeedback({ messageId: crypto.randomUUID(), actorId: actor.id, teamId: team.id, sessionId: session.id, kind: "positive" });
  await repo.submitFeedback({ messageId: crypto.randomUUID(), actorId: actor.id, teamId: team.id, sessionId: session.id, kind: "negative" });

  // Standalone skill usage
  await repo.submitSkillUsage({ actorId: actor.id, teamId: team.id, sessionId: null, skill: "code", count: 5 });

  const { items } = await repo.getTeamLeaderboard(team.id, { period: "week" });
  assert.ok(Array.isArray(items));

  const row = items.find((i: any) => i.actorId === actor.id);
  assert.ok(row, "actor must appear in leaderboard");

  // Check documented keys
  const docKeys = [
    "actorId", "teamId", "displayName", "period",
    "tokensUsed", "costUsd", "positiveFeedback", "negativeFeedback",
    "sessionCount", "skillUsage", "score",
  ].sort();
  assert.deepEqual(Object.keys(row).sort(), docKeys);

  // Check aggregates
  assert.equal(row.tokensUsed, 1500);
  assert.ok(Math.abs(Number(row.costUsd) - 0.07) < 0.0001, `costUsd should be ~0.07, got ${row.costUsd}`);
  assert.equal(row.positiveFeedback, 2);
  assert.equal(row.negativeFeedback, 1);
  assert.equal(row.sessionCount, 2);
  assert.equal(row.period, "week");
  assert.ok(typeof row.score === "number");

  // skillUsage should aggregate: search=3, summarize=2 from reports + code=5 standalone
  assert.ok(typeof row.skillUsage === "object");
  assert.equal(row.skillUsage["search"], 3);
  assert.equal(row.skillUsage["summarize"], 2);
  assert.equal(row.skillUsage["code"], 5);
});

test("getTeamLeaderboard period=all includes all rows", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, "AllActor");
  const repo = createPgBusinessRepository({ db });

  await repo.submitSessionReport({ actorId: actor.id, teamId: team.id, sessionId: null, tokensUsed: 200, costUsd: 0.01 });

  const { items } = await repo.getTeamLeaderboard(team.id, { period: "all" });
  const row = items.find((i: any) => i.actorId === actor.id);
  assert.ok(row);
  assert.equal(row.tokensUsed, 200);
});

// ── listFeedbackSummary ───────────────────────────────────────────────────────

// ── reportClientVersion ───────────────────────────────────────────────────────

test("reportClientVersion upserts latest per (actor, clientType, deviceId)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, "Versioned");
  const userId = crypto.randomUUID();
  await db.update(actors).set({ userId }).where(eq(actors.id, actor.id));

  const repo = createPgBusinessRepository({ db, userId });

  await repo.reportClientVersion(team.id, { clientType: "tauri", version: "0.1.82", deviceId: "mac-1", build: null });
  await repo.reportClientVersion(team.id, { clientType: "tauri", version: "0.1.83", deviceId: "mac-1", build: null });
  await repo.reportClientVersion(team.id, { clientType: "tauri", version: "0.1.80", deviceId: "mac-2", build: null });

  const rows = await db.select().from(actorClientVersions).where(eq(actorClientVersions.actorId, actor.id));
  assert.equal(rows.length, 2);
  const mac1 = rows.find((r) => r.deviceId === "mac-1");
  assert.equal(mac1.version, "0.1.83");
});

test("listFeedbackSummary aggregates positive/negative/total per actor", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actorA = await seedActor(db, team.id, "SummA");
  const actorB = await seedActor(db, team.id, "SummB");
  const repo = createPgBusinessRepository({ db });

  // actorA: 3 positive, 1 negative
  for (let i = 0; i < 3; i++) {
    await repo.submitFeedback({ messageId: crypto.randomUUID(), actorId: actorA.id, teamId: team.id, sessionId: null, kind: "positive" });
  }
  await repo.submitFeedback({ messageId: crypto.randomUUID(), actorId: actorA.id, teamId: team.id, sessionId: null, kind: "negative" });

  // actorB: 2 negative
  await repo.submitFeedback({ messageId: crypto.randomUUID(), actorId: actorB.id, teamId: team.id, sessionId: null, kind: "negative" });
  await repo.submitFeedback({ messageId: crypto.randomUUID(), actorId: actorB.id, teamId: team.id, sessionId: null, kind: "negative" });

  const { items } = await repo.listFeedbackSummary(team.id);
  assert.ok(Array.isArray(items));

  const a = items.find((i: any) => i.actorId === actorA.id);
  const b = items.find((i: any) => i.actorId === actorB.id);

  assert.ok(a, "actorA must appear in summary");
  assert.equal(a.positive, 3);
  assert.equal(a.negative, 1);
  assert.equal(a.total, 4);

  assert.ok(b, "actorB must appear in summary");
  assert.equal(b.positive, 0);
  assert.equal(b.negative, 2);
  assert.equal(b.total, 2);
});
