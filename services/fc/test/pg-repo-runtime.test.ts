/**
 * pg-repo-runtime — UUID-seed pglite tests for the RUNTIME domain.
 *
 * Covers: upsertAgentRuntime, getAgentRuntime, getLatestAgentRuntime,
 *         updateRuntimeCursor, updateRuntimeModel, listAgentRuntimesForTeam,
 *         listLatestAgentRuntimeHints, listSessionRuntimeModels,
 *         listRuntimeTargetsForSession, listDaemonRuntimes, heartbeat.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import {
  teams,
  actors,
  agents,
  members,
  teamMembers,
  sessions,
  workspaces,
} from "../src/db/schema/index.js";

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function makeDb() {
  const { db } = await makeTestDb();
  return db;
}

async function seedTeam(db: any) {
  const [t] = await db
    .insert(teams)
    .values({ name: "RuntimeTeam", slug: `rt-${Date.now()}-${Math.random()}` })
    .returning();
  return t;
}

async function seedAgentActor(db: any, teamId: string) {
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "agent", displayName: "TestAgent" })
    .returning();
  await db.insert(agents).values({ id: actor.id, agentKind: "claude", status: "offline", visibility: "team" });
  return actor;
}

async function seedMemberActor(db: any, teamId: string) {
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "TestMember", userId: `u-${Math.random()}` })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

async function seedSession(db: any, teamId: string) {
  const [s] = await db
    .insert(sessions)
    .values({ teamId, title: "Runtime Session", mode: "solo" })
    .returning();
  return s;
}

async function seedWorkspace(db: any, teamId: string) {
  const [w] = await db
    .insert(workspaces)
    .values({ teamId, name: `ws-${Date.now()}-${Math.random()}` })
    .returning();
  return w;
}

function makeRepo(db: any, agentActorId?: string) {
  return createPgBusinessRepository({ db, callerActorId: agentActorId });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("upsertAgentRuntime returns {id} truthy", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  const result = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-abc",
    backendSessionId: "bs-001",
  });
  assert.ok(result.id, "upsertAgentRuntime should return truthy id");
});

test("upsertAgentRuntime upserts on natural key (agent_id, backend_session_id)", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  const r1 = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-upsert",
    backendSessionId: "bs-upsert-key",
  });
  const r2 = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-upsert-updated",
    backendSessionId: "bs-upsert-key", // same natural key
  });
  assert.equal(r1.id, r2.id, "second upsert should return same row id");
});

// Regression: workspaceId must round-trip through upsert → read. The daemon
// relies on agent_runtimes.workspace_id for local-daemon session grouping;
// this assertion fails if the column is ever silently dropped on upsert.
test("upsertAgentRuntime persists workspaceId (round-trips through read)", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const workspace = await seedWorkspace(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-workspace",
    backendSessionId: "bs-workspace",
    workspaceId: workspace.id,
  });

  const result = await repo.getAgentRuntime({ sessionId: session.id, runtimeId: "rt-workspace" });
  assert.ok(result, "should find the row");
  assert.equal(result!.workspaceId, workspace.id, "persisted workspaceId should match the upsert body");
});

test("getAgentRuntime returns null when absent", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  const result = await repo.getAgentRuntime({ sessionId: session.id, runtimeId: "nonexistent" });
  assert.equal(result, null);
});

test("getAgentRuntime returns row by runtimeId when present", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-find",
    backendSessionId: "bs-find",
  });

  const result = await repo.getAgentRuntime({ sessionId: session.id, runtimeId: "rt-find" });
  assert.ok(result, "should find the row");
  assert.equal(result!.runtimeId, "rt-find");
});

test("getAgentRuntime returns row by backendSessionId when present", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-bsid",
    backendSessionId: "bs-lookup",
  });

  const result = await repo.getAgentRuntime({ sessionId: session.id, backendSessionId: "bs-lookup" });
  assert.ok(result, "should find by backendSessionId");
  assert.equal(result!.backendSessionId, "bs-lookup");
});

test("getLatestAgentRuntime returns null when absent", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  const result = await repo.getLatestAgentRuntime({ agentId: agentActor.id, sessionId: session.id });
  assert.equal(result, null);
});

test("getLatestAgentRuntime returns latest row when present", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-latest-old",
    backendSessionId: "bs-latest-old",
  });
  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-latest-new",
    backendSessionId: "bs-latest-new",
  });

  const result = await repo.getLatestAgentRuntime({ agentId: agentActor.id, sessionId: session.id });
  assert.ok(result, "should return a row");
  assert.equal(result!.runtimeId, "rt-latest-new");
});

test("listRuntimeTargetsForSession prefers latest updated_at regardless of status", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-target-live",
    backendSessionId: "bs-target-live",
    status: "running",
  });
  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-target-stopped",
    backendSessionId: "bs-target-stopped",
    status: "stopped",
  });

  const rows = await repo.listRuntimeTargetsForSession(session.id, [agentActor.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.runtime_id, "rt-target-stopped");
});

test("listRuntimeTargetsForSession returns latest runtime per agent", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-target-old",
    backendSessionId: "bs-target-old",
  });
  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-target-new",
    backendSessionId: "bs-target-new",
  });

  const rows = await repo.listRuntimeTargetsForSession(session.id, [agentActor.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.agent_id, agentActor.id);
  assert.equal(rows[0]?.runtime_id, "rt-target-new");
});

test("listRuntimeTargetsForSession with empty agentIds returns all session agents", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentA = await seedAgentActor(db, team.id);
  const agentB = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentA.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentA.id,
    sessionId: session.id,
    runtimeId: "rt-a",
    backendSessionId: "bs-a",
  });
  await repo.upsertAgentRuntime({
    agentActorId: agentB.id,
    sessionId: session.id,
    runtimeId: "rt-b",
    backendSessionId: "bs-b",
  });

  const rows = await repo.listRuntimeTargetsForSession(session.id, []);
  assert.equal(rows.length, 2);
  const byAgent = new Map(rows.map((r: any) => [r.agent_id, r.runtime_id]));
  assert.equal(byAgent.get(agentA.id), "rt-a");
  assert.equal(byAgent.get(agentB.id), "rt-b");
});

test("updateRuntimeCursor persists lastProcessedMessageId", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  const { id } = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-cursor",
    backendSessionId: "bs-cursor",
  });

  const msgId = "00000000-0000-0000-0000-000000000001";
  // Should not throw
  await assert.doesNotReject(() => repo.updateRuntimeCursor(id, { lastProcessedMessageId: msgId }));
});

test("updateRuntimeModel persists model", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-model",
    backendSessionId: "bs-model",
  });

  // Should not throw
  await assert.doesNotReject(() => repo.updateRuntimeModel("rt-model", "claude-3-5-sonnet"));
});

test("listAgentRuntimesForTeam returns inserted rows", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-list",
    backendSessionId: "bs-list",
  });

  const rows = await repo.listAgentRuntimesForTeam(team.id);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r: any) => r.runtimeId === "rt-list"));
});

test("listLatestAgentRuntimeHints returns latest per agent", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-hint",
    backendSessionId: "bs-hint",
  });

  const hints = await repo.listLatestAgentRuntimeHints(team.id, [agentActor.id]);
  assert.ok(Array.isArray(hints));
  assert.ok(hints.length >= 1);
});

test("listSessionRuntimeModels returns rows for session", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-models",
    backendSessionId: "bs-models",
    currentModel: "claude-3-5-haiku",
  });

  const rows = await repo.listSessionRuntimeModels(session.id);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  const row = rows.find((r: any) => r.runtime_id === "rt-models");
  assert.ok(row, "expected the upserted runtime row");
  // Extended fields consumed by the expo session-members screen.
  assert.equal(row.agent_id, agentActor.id);
  assert.ok("id" in row, "id field present");
  assert.ok("workspace_id" in row, "workspace_id field present");
  assert.ok("status" in row, "status field present");
});

test("listRuntimeTargetsForSession returns agent+runtimeId pairs", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-target",
    backendSessionId: "bs-target",
  });

  const rows = await repo.listRuntimeTargetsForSession(session.id, [agentActor.id]);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r: any) => r.agent_id === agentActor.id));
});

test("listDaemonRuntimes returns rows for team", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-daemon",
    backendSessionId: "bs-daemon",
  });

  const rows = await repo.listDaemonRuntimes(team.id);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((r: any) => r.runtimeId === "rt-daemon"));
});

test("heartbeat does not throw", async () => {
  const db = await makeDb();
  const repo = makeRepo(db);
  await assert.doesNotReject(() => repo.heartbeat());
});

test("heartbeat updates member actor last_active_at via userId when callerActorId absent", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const member = await seedMemberActor(db, team.id);
  const stale = new Date("2020-01-01T00:00:00.000Z");
  await db.update(actors).set({ lastActiveAt: stale }).where(eq(actors.id, member.id));

  const repo = createPgBusinessRepository({ db, userId: member.userId! });
  await repo.heartbeat();

  const [row] = await db.select().from(actors).where(eq(actors.id, member.id));
  assert.ok(row.lastActiveAt);
  assert.ok(new Date(row.lastActiveAt!).getTime() > stale.getTime());
});

// Fix #runtime — null backendSessionId upsert should be idempotent (one row, updated)
test("upsertAgentRuntime with null backendSessionId: two upserts → ONE row, updated", async () => {
  const db = await makeDb();
  const team = await seedTeam(db);
  const agentActor = await seedAgentActor(db, team.id);
  const session = await seedSession(db, team.id);
  const repo = makeRepo(db, agentActor.id);

  // First upsert with backendSessionId=null
  const r1 = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-null-bs-1",
    backendSessionId: null,
    status: "running",
  });
  assert.ok(r1.id, "first upsert returns id");

  // Second upsert with backendSessionId=null for the same agent → should update, not insert
  const r2 = await repo.upsertAgentRuntime({
    agentActorId: agentActor.id,
    sessionId: session.id,
    runtimeId: "rt-null-bs-updated",
    backendSessionId: null,
    status: "stopped",
  });
  assert.ok(r2.id, "second upsert returns id");
  assert.equal(r1.id, r2.id, "both upserts return the same row id (no duplicate)");

  // Verify only ONE row exists for this agent with null backendSessionId
  const allRuntimes = await repo.listAgentRuntimesForTeam(team.id);
  const nullBsRows = allRuntimes.filter(
    (r: any) => r.agentId === agentActor.id && r.backendSessionId === null,
  );
  assert.equal(nullBsRows.length, 1, "exactly one row with null backendSessionId");
  assert.equal(nullBsRows[0].runtimeId, "rt-null-bs-updated", "row reflects the updated runtimeId");
  assert.equal(nullBsRows[0].status, "stopped", "row reflects the updated status");
});
