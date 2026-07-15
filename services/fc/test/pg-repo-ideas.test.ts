/**
 * pg-repo-ideas — UUID-seed pglite tests asserting the IDEAS domain contract shapes.
 *
 * Pattern established here is the template for all remaining domain batches (Plan 5).
 * - makeTestDb() creates a fresh in-process pglite with migrations applied.
 * - Seed helpers insert teams + actors with .returning() to get real UUIDs.
 * - Each test constructs its own repo instance (no shared state).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers } from "../src/db/schema/index.js";

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedTeam(db: any, over: Record<string, any> = {}) {
  const [t] = await db
    .insert(teams)
    .values({ name: "TestTeam", slug: `test-${Date.now()}-${Math.random()}`, ...over })
    .returning();
  return t;
}

/**
 * Insert an actor that is also a member of the team (required for ideas authz).
 * Returns { actor, userId } where userId can be passed as ctx.userId.
 */
async function seedMember(db: any, teamId: string, userId = `user-${Math.random()}`) {
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "Member", userId })
    .returning();
  // ideas.ts FK requires a members row + team_members row for authz
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return { actor, userId };
}

// ── listIdeas ─────────────────────────────────────────────────────────────────

test("listIdeas returns paged ideas with canonical contract keys", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);
  const repo = createPgBusinessRepository({ db });

  // Seed two ideas
  await repo.createIdea({ teamId: team.id, title: "Alpha", authorActorId: actor.id });
  await repo.createIdea({ teamId: team.id, title: "Beta", authorActorId: actor.id });

  const page = await repo.listIdeas({ teamId: team.id, archived: false, limit: 50, cursor: null });
  assert.ok(Array.isArray(page.items));
  assert.equal(page.items.length, 2);

  const contractKeys = [
    "actorIds", "archived", "authorActorId", "createdAt",
    "description", "id", "teamId", "title", "updatedAt",
  ].sort();
  assert.deepEqual(Object.keys(page.items[0]).sort(), contractKeys);
});

test("listIdeas archived filter excludes non-archived ideas", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const idea = await repo.createIdea({ teamId: team.id, title: "To Archive", authorActorId: actor.id });
  await repo.archiveIdea(idea.id);

  const active = await repo.listIdeas({ teamId: team.id, archived: false, limit: 50, cursor: null });
  const archived = await repo.listIdeas({ teamId: team.id, archived: true, limit: 50, cursor: null });

  assert.equal(active.items.find((i: any) => i.id === idea.id), undefined);
  assert.ok(archived.items.find((i: any) => i.id === idea.id));
});

// ── getIdea ───────────────────────────────────────────────────────────────────

test("getIdea returns the idea by id", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const created = await repo.createIdea({ teamId: team.id, title: "FindMe", authorActorId: actor.id });
  const found = await repo.getIdea(created.id);
  assert.ok(found);
  assert.equal(found.id, created.id);
  assert.equal(found.title, "FindMe");
});

test("getIdea returns null for missing idea", async () => {
  const { db } = await makeTestDb();
  const repo = createPgBusinessRepository({ db });
  const result = await repo.getIdea("00000000-0000-0000-0000-000000000000");
  assert.equal(result, null);
});

// ── createIdea ────────────────────────────────────────────────────────────────

test("createIdea returns shape with archived:false and correct authorActorId", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const idea = await repo.createIdea({
    teamId: team.id,
    title: "New Idea",
    authorActorId: actor.id,
  });

  assert.ok(idea);
  assert.equal(idea.title, "New Idea");
  assert.equal(idea.archived, false);
  assert.equal(idea.teamId, team.id);
  assert.equal(idea.authorActorId, actor.id);
  assert.ok(Array.isArray(idea.actorIds));
  assert.ok(typeof idea.createdAt === "string");
  assert.ok(typeof idea.updatedAt === "string");
});

// ── updateIdea ────────────────────────────────────────────────────────────────

test("updateIdea mutates title and returns updated shape", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const idea = await repo.createIdea({ teamId: team.id, title: "Original", authorActorId: actor.id });
  const updated = await repo.updateIdea(idea.id, { title: "Updated Title" });

  assert.ok(updated);
  assert.equal(updated.id, idea.id);
  assert.equal(updated.title, "Updated Title");
});

// ── archiveIdea ───────────────────────────────────────────────────────────────

test("archiveIdea succeeds (no throw)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const idea = await repo.createIdea({ teamId: team.id, title: "Archive Me", authorActorId: actor.id });
  await repo.archiveIdea(idea.id);

  const found = await repo.getIdea(idea.id);
  assert.ok(found);
  assert.equal(found.archived, true);
});

// ── createIdeaActivity ────────────────────────────────────────────────────────

test("createIdeaActivity returns canonical 7-key shape", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const idea = await repo.createIdea({ teamId: team.id, title: "Activity Test", authorActorId: actor.id });
  const activity = await repo.createIdeaActivity(idea.id, {
    kind: "comment",
    actorId: actor.id,
    content: "hello world",
    metadata: null,
  });

  assert.ok(activity);
  assert.deepEqual(Object.keys(activity).sort(), [
    "actorId", "content", "createdAt", "id", "ideaId", "kind", "metadata",
  ].sort());
  assert.equal(activity.kind, "comment");
  assert.equal(activity.actorId, actor.id);
  assert.equal(activity.ideaId, idea.id);
  assert.equal(activity.content, "hello world");
  assert.equal(activity.metadata, null);
  assert.ok(typeof activity.createdAt === "string");
});

// ── listIdeaActivities ────────────────────────────────────────────────────────

test("listIdeaActivities returns items array", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const idea = await repo.createIdea({ teamId: team.id, title: "Listing", authorActorId: actor.id });
  await repo.createIdeaActivity(idea.id, { kind: "note", actorId: actor.id, content: "one", metadata: null });
  await repo.createIdeaActivity(idea.id, { kind: "note", actorId: actor.id, content: "two", metadata: null });

  const result = await repo.listIdeaActivities(idea.id);
  assert.ok(result);
  assert.ok(Array.isArray(result.items));
  assert.equal(result.items.length, 2);
});

// ── reorderIdeas ──────────────────────────────────────────────────────────────

test("reorderIdeas succeeds for a batch of idea ids", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const a = await repo.createIdea({ teamId: team.id, title: "A", authorActorId: actor.id });
  const b = await repo.createIdea({ teamId: team.id, title: "B", authorActorId: actor.id });
  // Should not throw
  await repo.reorderIdeas({ teamId: team.id, ideaIds: [b.id, a.id] });
});

// ── listIdeasForSync ──────────────────────────────────────────────────────────

test("listIdeasForSync returns all team ideas", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);
  const repo = createPgBusinessRepository({ db });

  await repo.createIdea({ teamId: team.id, title: "Sync1", authorActorId: actor.id });
  await repo.createIdea({ teamId: team.id, title: "Sync2", authorActorId: actor.id });

  const rows = await repo.listIdeasForSync(team.id, null);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 2);
  // Sync rows are snake_case (consumed directly by the client's lib/sync/idea-sync).
  const r = rows[0];
  assert.ok("team_id" in r && "sort_order" in r && "created_by_actor_id" in r && "created_at" in r, "must be snake_case");
  assert.ok(!("teamId" in r), "must not leak camelCase keys");
});

// ── authz test ────────────────────────────────────────────────────────────────

test("createIdea with a non-member userId throws 403 when userId is provided in ctx", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedMember(db, team.id);

  // This repo has a userId in ctx that is NOT a team member
  const nonMemberUserId = "not-a-member-user";
  const repo = createPgBusinessRepository({ db, userId: nonMemberUserId });

  // createIdea with an explicit authorActorId bypasses userId authz —
  // the authz check is on the userId-based path (no explicit authorActorId omitted)
  // We test that when a non-member tries without providing an explicit actorId,
  // the repo rejects them.
  await assert.rejects(
    () => repo.createIdea({ teamId: team.id, title: "Forbidden", userId: nonMemberUserId }),
    (err: any) => err?.status === 403 || err?.code === "forbidden" || /forbidden|member/i.test(err?.message ?? ""),
  );

  // Sanity: a legitimate member can still create via explicit authorActorId
  const good = await repo.createIdea({ teamId: team.id, title: "Allowed", authorActorId: actor.id });
  assert.ok(good);
});
