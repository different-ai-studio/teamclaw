/**
 * pg-repo-authz — application-layer authz for remove_team_actor parity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { assertCanRemoveTeamActor } from "../src/lib/pg-repo/authz.js";
import { actors, members, teamMembers, agents } from "../src/db/schema/index.js";

async function seedMember(
  db: any,
  teamId: string,
  opts: { userId: string; role?: string; displayName?: string },
) {
  const [actor] = await db.insert(actors).values({
    teamId,
    actorType: "member",
    displayName: opts.displayName ?? "Member",
    userId: opts.userId,
  }).returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({
    teamId,
    memberId: actor.id,
    role: opts.role ?? "member",
  });
  return actor;
}

async function seedAgent(
  db: any,
  teamId: string,
  ownerMemberId: string,
  visibility: "personal" | "team",
) {
  const [agentActor] = await db.insert(actors).values({
    teamId,
    actorType: "agent",
    displayName: visibility === "personal" ? "Personal Bot" : "Team Bot",
  }).returning();
  await db.insert(agents).values({
    id: agentActor.id,
    agentKind: "daemon",
    status: "active",
    visibility,
    ownerMemberId,
  });
  return agentActor;
}

test("assertCanRemoveTeamActor allows personal-agent owner", async () => {
  const { db } = await makeTestDb();
  const ownerUserId = `user-${Math.random()}`;
  const repo = createPgBusinessRepository({ db, userId: ownerUserId });
  const team = await repo.createTeam({ name: "Authz Personal Team" });

  const ownerMember = await db.query.actors.findFirst({ where: eq(actors.teamId, team.id) });
  assert.ok(ownerMember);

  const memberUserId = `user-${Math.random()}`;
  const memberActor = await seedMember(db, team.id, { userId: memberUserId });
  const personalAgent = await seedAgent(db, team.id, memberActor.id, "personal");

  await assert.doesNotReject(() =>
    assertCanRemoveTeamActor(db, memberUserId, team.id, {
      id: personalAgent.id,
      actor_type: "agent",
      visibility: "personal",
      ownerMemberId: memberActor.id,
    }),
  );
});

test("assertCanRemoveTeamActor rejects non-owner deleting personal agent", async () => {
  const { db } = await makeTestDb();
  const ownerUserId = `user-${Math.random()}`;
  const repo = createPgBusinessRepository({ db, userId: ownerUserId });
  const team = await repo.createTeam({ name: "Authz Personal Deny Team" });

  const ownerMember = await db.query.actors.findFirst({ where: eq(actors.teamId, team.id) });
  assert.ok(ownerMember);

  const memberActor = await seedMember(db, team.id, { userId: `user-${Math.random()}` });
  const personalAgent = await seedAgent(db, team.id, memberActor.id, "personal");

  await assert.rejects(
    () =>
      assertCanRemoveTeamActor(db, ownerUserId, team.id, {
        id: personalAgent.id,
        actor_type: "agent",
        visibility: "personal",
        ownerMemberId: memberActor.id,
      }),
    (e: any) => /requires agent owner for personal agents/i.test(String(e?.message ?? e)),
  );
});

test("assertCanRemoveTeamActor rejects member deleting team agent", async () => {
  const { db } = await makeTestDb();
  const ownerUserId = `user-${Math.random()}`;
  const repo = createPgBusinessRepository({ db, userId: ownerUserId });
  const team = await repo.createTeam({ name: "Authz Team Agent Team" });

  const memberUserId = `user-${Math.random()}`;
  const memberActor = await seedMember(db, team.id, { userId: memberUserId });
  const teamAgent = await seedAgent(db, team.id, memberActor.id, "team");

  await assert.rejects(
    () =>
      assertCanRemoveTeamActor(db, memberUserId, team.id, {
        id: teamAgent.id,
        actor_type: "agent",
        visibility: "team",
        ownerMemberId: memberActor.id,
      }),
    (e: any) => /requires owner or admin for team agents/i.test(String(e?.message ?? e)),
  );
});

test("assertCanRemoveTeamActor allows admin to delete team agent", async () => {
  const { db } = await makeTestDb();
  const ownerUserId = `user-${Math.random()}`;
  const adminUserId = `user-${Math.random()}`;
  const repo = createPgBusinessRepository({ db, userId: ownerUserId });
  const team = await repo.createTeam({ name: "Authz Team Agent Admin Team" });

  await seedMember(db, team.id, { userId: adminUserId, role: "admin" });
  const ownerActor = await seedMember(db, team.id, { userId: `user-${Math.random()}`, role: "member" });
  const teamAgent = await seedAgent(db, team.id, ownerActor.id, "team");

  await assert.doesNotReject(() =>
    assertCanRemoveTeamActor(db, adminUserId, team.id, {
      id: teamAgent.id,
      actor_type: "agent",
      visibility: "team",
      ownerMemberId: ownerActor.id,
    }),
  );
});
