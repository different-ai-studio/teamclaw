import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers, sessionParticipants } from "../src/db/schema/index.js";
import { eq } from "drizzle-orm";

async function seedTeam(db: any) {
  const [t] = await db.insert(teams).values({ name: "T", slug: `t-${Math.random()}` }).returning();
  return t;
}
async function seedActor(db: any, teamId: string) {
  const userId = `user-${Math.random()}`;
  const [a] = await db.insert(actors).values({ teamId, actorType: "member", displayName: "A", userId }).returning();
  await db.insert(members).values({ id: a.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: a.id, role: "member" });
  return a;
}

test("joinSession adds a team member as participant and returns the session", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const creator = await seedActor(db, team.id);
  const joiner = await seedActor(db, team.id); // same team, not yet a participant

  const writer = createPgBusinessRepository({ db });
  const s = await writer.createSession({ teamId: team.id, title: "Shared", mode: "collab", participantActorIds: [creator.id] });

  const repo = createPgBusinessRepository({ db, userId: joiner.userId });
  const out = await repo.joinSession(s.id);

  assert.equal(out.id, s.id);
  assert.ok(out.participants.some((p: any) => p.actorId === joiner.id), "joiner should be a participant");
});

test("joinSession is idempotent for an existing participant", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedActor(db, team.id);
  const writer = createPgBusinessRepository({ db });
  const s = await writer.createSession({ teamId: team.id, title: "Idem", mode: "collab", participantActorIds: [member.id] });

  const repo = createPgBusinessRepository({ db, userId: member.userId });
  await repo.joinSession(s.id);
  await repo.joinSession(s.id);

  const rows = await db.select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, s.id));
  const mine = rows.filter((r: any) => r.actorId === member.id);
  assert.equal(mine.length, 1, "no duplicate participant rows");
});

test("joinSession throws 403 when caller is not a member of the session's team", async () => {
  const { db } = await makeTestDb();
  const teamA = await seedTeam(db);
  const teamB = await seedTeam(db);
  const owner = await seedActor(db, teamA.id);
  const outsider = await seedActor(db, teamB.id);
  const writer = createPgBusinessRepository({ db });
  const s = await writer.createSession({ teamId: teamA.id, title: "Private", mode: "collab", participantActorIds: [owner.id] });

  const repo = createPgBusinessRepository({ db, userId: outsider.userId });
  await assert.rejects(() => repo.joinSession(s.id), /forbidden|not a member/i);
});

test("joinSession throws 404 for a missing session", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: member.userId });
  await assert.rejects(() => repo.joinSession("00000000-0000-0000-0000-000000000000"), /not_found|not found/i);
});

test("joinSession throws 401 with no authenticated user", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const member = await seedActor(db, team.id);
  const writer = createPgBusinessRepository({ db });
  const s = await writer.createSession({ teamId: team.id, title: "NoAuth", mode: "collab", participantActorIds: [member.id] });

  const repo = createPgBusinessRepository({ db }); // no userId
  await assert.rejects(() => repo.joinSession(s.id), /missing_auth|cannot resolve/i);
});
