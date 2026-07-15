/**
 * pg-repo-messages — UUID-seed pglite tests for the MESSAGES domain.
 *
 * Follows the same pattern as pg-repo-sessions.test.ts:
 * - makeTestDb() → fresh in-process pglite with migrations applied.
 * - Seed helpers insert teams + actors + sessions.
 * - Each test constructs its own repo instance via createPgBusinessRepository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { makeMessagesRepo } from "../src/lib/pg-repo/messages.js";
import { teams, actors, members, teamMembers } from "../src/db/schema/index.js";

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedTeam(db: any) {
  const [t] = await db
    .insert(teams)
    .values({ name: "MsgTeam", slug: `msg-${Date.now()}-${Math.random()}` })
    .returning();
  return t;
}

async function seedActor(db: any, teamId: string) {
  const [actor] = await db
    .insert(actors)
    .values({
      teamId,
      actorType: "member",
      displayName: "Msg Actor",
      userId: `user-msg-${Math.random()}`,
    })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

async function seedSession(repo: any, teamId: string, actorId: string, title = "MsgSession") {
  return repo.createSession({ teamId, title, mode: "solo", participantActorIds: [actorId] });
}

// ── listMessages ──────────────────────────────────────────────────────────────

test("listMessages returns empty array for session with no messages", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  const msgs = await repo.listMessages(session.id);
  assert.ok(Array.isArray(msgs), "should return an array");
  assert.equal(msgs.length, 0);
});

test("listMessages returns messages with contract keys", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  await repo.insertMessage(session.id, {
    teamId: team.id,
    kind: "text",
    content: "Hello",
    senderActorId: actor.id,
  });

  const msgs = await repo.listMessages(session.id);
  assert.ok(msgs.length >= 1);

  const contractKeys = [
    "id", "teamId", "sessionId", "turnId", "senderActorId",
    "replyToMessageId", "kind", "content", "metadata", "model",
    "createdAt", "updatedAt",
  ].sort();
  assert.deepEqual(Object.keys(msgs[0]).sort(), contractKeys);
});

test("listMessages returns messages ordered by createdAt asc, id asc", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  await repo.insertMessage(session.id, { teamId: team.id, kind: "text", content: "First", senderActorId: actor.id });
  await new Promise((r) => setTimeout(r, 5));
  await repo.insertMessage(session.id, { teamId: team.id, kind: "text", content: "Second", senderActorId: actor.id });

  const msgs = await repo.listMessages(session.id);
  assert.ok(msgs.length >= 2);
  assert.equal(msgs[0].content, "First");
  assert.equal(msgs[1].content, "Second");
});

// ── insertMessage ─────────────────────────────────────────────────────────────

test("insertMessage returns message with all contract keys populated", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  const msg = await repo.insertMessage(session.id, {
    teamId: team.id,
    kind: "text",
    content: "Test content",
    senderActorId: actor.id,
    model: "gpt-4",
    turnId: "turn-abc",
    metadata: { foo: "bar" },
  });

  assert.ok(msg.id, "id should be present");
  assert.equal(msg.sessionId, session.id);
  assert.equal(msg.teamId, team.id);
  assert.equal(msg.kind, "text");
  assert.equal(msg.content, "Test content");
  assert.equal(msg.senderActorId, actor.id);
  assert.equal(msg.model, "gpt-4");
  assert.equal(msg.turnId, "turn-abc");
  assert.ok(msg.createdAt, "createdAt should be present");
  assert.ok(msg.updatedAt, "updatedAt should be present");
});

test("insertMessage with duplicate id surfaces 23505 or conflict error", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  const dupId = "11111111-2222-3333-4444-555555555555";
  await repo.insertMessage(session.id, {
    id: dupId,
    teamId: team.id,
    kind: "text",
    content: "First insert",
    senderActorId: actor.id,
  });

  let caught: any = null;
  try {
    await repo.insertMessage(session.id, {
      id: dupId,
      teamId: team.id,
      kind: "text",
      content: "Duplicate insert",
      senderActorId: actor.id,
    });
  } catch (err: any) {
    caught = err;
  }

  assert.ok(caught, "should throw on duplicate id");
  const code = caught?.code ?? caught?.cause?.code;
  assert.ok(
    code === "23505" || code === "conflict",
    `expected 23505 or conflict, got: ${JSON.stringify(code)}`,
  );
});

// ── patchMessage ──────────────────────────────────────────────────────────────

test("patchMessage updates content and returns {id, content}", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  const msg = await repo.insertMessage(session.id, {
    teamId: team.id, kind: "text", content: "Original", senderActorId: actor.id,
  });

  const patched = await repo.patchMessage(msg.id, { content: "Patched content" });
  assert.ok(patched, "patchMessage should return something");
  assert.equal(patched.id, msg.id);
  assert.equal(patched.content, "Patched content");
});

test("patchMessage returns null for unknown id", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });
  const result = await repo.patchMessage("00000000-0000-0000-0000-000000000000", { content: "x" });
  assert.equal(result, null);
});

// ── deleteMessage ─────────────────────────────────────────────────────────────

test("deleteMessage removes the message", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  const msg = await repo.insertMessage(session.id, {
    teamId: team.id, kind: "text", content: "To be deleted", senderActorId: actor.id,
  });

  await repo.deleteMessage(msg.id);

  const msgs = await repo.listMessages(session.id);
  assert.ok(!msgs.find((m: any) => m.id === msg.id), "message should be deleted");
});

// ── listMessagesForSessionSince ───────────────────────────────────────────────

test("listMessagesForSessionSince returns messages updated after timestamp", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  const before = new Date(Date.now() - 10000).toISOString();
  await repo.insertMessage(session.id, {
    teamId: team.id, kind: "text", content: "Since test", senderActorId: actor.id,
  });

  const rows = await repo.listMessagesForSessionSince(session.id, before);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1, "should return at least one message");
  // Sync rows are snake_case (consumed directly by the client's lib/sync/message-sync).
  const r = rows[0];
  assert.ok("team_id" in r && "session_id" in r && "turn_id" in r && "created_at" in r, "must be snake_case");
  assert.ok(!("sessionId" in r), "must not leak camelCase keys");
});

test("listMessagesForSessionSince with null updatedAfter returns all messages", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  await repo.insertMessage(session.id, { teamId: team.id, kind: "text", content: "A", senderActorId: actor.id });
  await repo.insertMessage(session.id, { teamId: team.id, kind: "text", content: "B", senderActorId: actor.id });

  const rows = await repo.listMessagesForSessionSince(session.id, null);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 2);
});

// ── dispatchPush injection ────────────────────────────────────────────────────

test("insertMessage calls injected dispatchPush once with snake_case record", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  const calls: any[] = [];
  const messagesRepo = makeMessagesRepo(db, {
    dispatchPush: async (record) => { calls.push(record); },
  });

  const msg = await messagesRepo.insertMessage(session.id, {
    teamId: team.id,
    kind: "text",
    content: "Push test",
    senderActorId: actor.id,
  });

  // Give the fire-and-forget microtask a chance to settle
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.length, 1, "dispatchPush should be called exactly once");
  const rec = calls[0];
  assert.equal(rec.id, msg.id, "record.id should match inserted message id");
  assert.equal(rec.session_id, session.id, "record.session_id should be snake_case");
  assert.equal(rec.team_id, team.id, "record.team_id should be snake_case");
  assert.equal(rec.sender_actor_id, actor.id, "record.sender_actor_id should be snake_case");
  assert.equal(rec.kind, "text");
  assert.equal(rec.content, "Push test");
});

test("insertMessage succeeds even when dispatchPush throws", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });
  const session = await seedSession(repo, team.id, actor.id);

  const messagesRepo = makeMessagesRepo(db, {
    dispatchPush: async () => { throw new Error("push failure"); },
  });

  // Should not throw despite dispatchPush failing
  const msg = await messagesRepo.insertMessage(session.id, {
    teamId: team.id,
    kind: "text",
    content: "Push throws",
    senderActorId: actor.id,
  });

  // Wait for the swallowed rejection to settle
  await new Promise((r) => setImmediate(r));

  assert.ok(msg.id, "message should be inserted successfully");

  // Verify the message is actually persisted in the DB
  const allMsgs = await repo.listMessages(session.id);
  assert.ok(allMsgs.some((m: any) => m.id === msg.id), "message should be in DB");
});
