import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import {
  resolveActorForTeam,
  requireActorForTeam,
  checkTeamMembership,
  resolveActorForAgent,
  checkAgentOwnership,
  checkAgentPermission,
} from "../src/lib/pg-repo/authz.js";
import { teams, actors, members, teamMembers, agents, agentMemberAccess } from "../src/db/schema/index.js";

async function seed(db: any) {
  const [tA] = await db.insert(teams).values({ name: "A", slug: "a" }).returning();
  const [tB] = await db.insert(teams).values({ name: "B", slug: "b" }).returning();
  // user-U has actors in BOTH teams; actor in tA created first.
  const [aA] = await db
    .insert(actors)
    .values({ teamId: tA.id, actorType: "member", displayName: "U@A", userId: "user-U" })
    .returning();
  await db.insert(members).values({ id: aA.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: tA.id, memberId: aA.id, role: "owner" });

  const [aB] = await db
    .insert(actors)
    .values({ teamId: tB.id, actorType: "member", displayName: "U@B", userId: "user-U" })
    .returning();
  await db.insert(members).values({ id: aB.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: tB.id, memberId: aB.id, role: "member" });

  return { tA, tB, aA, aB };
}

test("resolveActorForTeam is team-scoped (fixes current_member_id multi-team bug)", async () => {
  const { db } = await makeTestDb();
  const { tA, tB, aA, aB } = await seed(db);
  assert.equal(await resolveActorForTeam(db, "user-U", tA.id), aA.id);
  assert.equal(await resolveActorForTeam(db, "user-U", tB.id), aB.id);
  assert.equal(await resolveActorForTeam(db, "user-U", "00000000-0000-0000-0000-000000000000"), null);
  assert.equal(await resolveActorForTeam(db, "user-unknown", tA.id), null);
});

test("requireActorForTeam throws 403 for non-member", async () => {
  const { db } = await makeTestDb();
  const { tA, aA } = await seed(db);
  const resolved = await resolveActorForTeam(db, "user-U", tA.id);
  assert.equal(await requireActorForTeam(db, "user-U", tA.id), resolved);
  await assert.rejects(() => requireActorForTeam(db, "user-stranger", tA.id), /forbidden|member/i);
});

test("checkTeamMembership reflects membership", async () => {
  const { db } = await makeTestDb();
  const { tA } = await seed(db);
  assert.equal(await checkTeamMembership(db, "user-U", tA.id), true);
  assert.equal(await checkTeamMembership(db, "user-stranger", tA.id), false);
});

test("resolveActorForAgent resolves caller's actor in the agent's team", async () => {
  const { db } = await makeTestDb();
  const { tA, aA } = await seed(db);
  const [agentActor] = await db
    .insert(actors)
    .values({ teamId: tA.id, actorType: "agent", displayName: "Bot" })
    .returning();
  await db.insert(agents).values({
    id: agentActor.id,
    ownerMemberId: aA.id,
    agentKind: "assistant",
    status: "active",
    visibility: "team",
  });
  assert.equal(await resolveActorForAgent(db, "user-U", agentActor.id), aA.id);
});

test("checkAgentOwnership returns true only for owner", async () => {
  const { db } = await makeTestDb();
  const { tA, tB, aA, aB } = await seed(db);
  const [agentActor] = await db
    .insert(actors)
    .values({ teamId: tA.id, actorType: "agent", displayName: "Bot" })
    .returning();
  await db.insert(agents).values({
    id: agentActor.id,
    ownerMemberId: aA.id,
    agentKind: "assistant",
    status: "active",
    visibility: "team",
  });
  assert.equal(await checkAgentOwnership(db, "user-U", agentActor.id), true);
  // user-U's actor in tB is NOT the owner of this agent in tA
  assert.equal(await checkAgentOwnership(db, "user-stranger", agentActor.id), false);
});

test("checkAgentPermission returns permission level or null", async () => {
  const { db } = await makeTestDb();
  const { tA, aA } = await seed(db);
  const [agentActor] = await db
    .insert(actors)
    .values({ teamId: tA.id, actorType: "agent", displayName: "Bot" })
    .returning();
  await db.insert(agents).values({
    id: agentActor.id,
    ownerMemberId: aA.id,
    agentKind: "assistant",
    status: "active",
    visibility: "team",
  });
  await db.insert(agentMemberAccess).values({
    agentId: agentActor.id,
    memberId: aA.id,
    permissionLevel: "read",
  });
  assert.equal(await checkAgentPermission(db, aA.id, agentActor.id), "read");
  assert.equal(await checkAgentPermission(db, "00000000-0000-0000-0000-000000000000", agentActor.id), null);
});
