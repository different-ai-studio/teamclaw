import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./pglite.js";
import {
  teams, actors, members, teamMembers,
  sessions, sessionParticipants,
  messages,
  workspaces,
  ideas, ideaActivities,
  agents, agentMemberAccess,
  agentRuntimes,
  actorDirectory,
} from "../../src/db/schema/index.js";
import { sql } from "drizzle-orm";

test("new domain tables apply and accept rows", async () => {
  const { db } = await makeTestDb();

  // team
  const [team] = await db.insert(teams).values({ name: "Test", slug: "test" }).returning();
  assert.ok(team.id);

  // actor (member)
  const [memberActor] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "member",
    displayName: "Alice",
  }).returning();
  assert.ok(memberActor.id);

  // member
  await db.insert(members).values({ id: memberActor.id, status: "active" });

  // team_member
  const [tm] = await db.insert(teamMembers).values({
    teamId: team.id,
    memberId: memberActor.id,
    role: "owner",
  }).returning();
  assert.ok(tm.id);

  // workspace
  const [ws] = await db.insert(workspaces).values({
    teamId: team.id,
    name: "main",
  }).returning();
  assert.ok(ws.id);

  // agent actor
  const [agentActor] = await db.insert(actors).values({
    teamId: team.id,
    actorType: "agent",
    displayName: "Bot",
  }).returning();

  // agent
  const [agent] = await db.insert(agents).values({
    id: agentActor.id,
    agentKind: "claude",
    status: "active",
    visibility: "team",
    ownerMemberId: memberActor.id,
  }).returning();
  assert.ok(agent.id);

  // idea
  const [idea] = await db.insert(ideas).values({
    teamId: team.id,
    createdByActorId: memberActor.id,
    title: "First idea",
    status: "open",
  }).returning();
  assert.ok(idea.id);

  // idea_activity
  const [ia] = await db.insert(ideaActivities).values({
    teamId: team.id,
    ideaId: idea.id,
    actorId: memberActor.id,
    activityType: "progress",
    content: "made progress",
  }).returning();
  assert.ok(ia.id);

  // session
  const [session] = await db.insert(sessions).values({
    teamId: team.id,
    mode: "solo",
    title: "Session 1",
  }).returning();
  assert.ok(session.id);

  // session_participant
  await db.insert(sessionParticipants).values({
    sessionId: session.id,
    actorId: memberActor.id,
  });

  // message
  const [msg] = await db.insert(messages).values({
    teamId: team.id,
    sessionId: session.id,
    kind: "text",
    content: "Hello",
  }).returning();
  assert.ok(msg.id);

  // agent_runtime
  const [rt] = await db.insert(agentRuntimes).values({
    teamId: team.id,
    agentId: agent.id,
    backendType: "claude",
    status: "running",
  }).returning();
  assert.ok(rt.id);
});

test("actor_directory view returns actor rows", async () => {
  const { db } = await makeTestDb();

  const [team] = await db.insert(teams).values({ name: "ViewTeam", slug: "viewteam" }).returning();
  const [memberActor] = await db.insert(actors).values({
    teamId: team.id, actorType: "member", displayName: "Bob",
  }).returning();
  await db.insert(members).values({ id: memberActor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId: team.id, memberId: memberActor.id, role: "member" });

  const [agentActor] = await db.insert(actors).values({
    teamId: team.id, actorType: "agent", displayName: "TeamBot",
  }).returning();
  await db.insert(agents).values({
    id: agentActor.id,
    agentKind: "claude",
    status: "active",
    visibility: "team",
    ownerMemberId: memberActor.id,
  });

  const rows = await db.select().from(actorDirectory).where(sql`team_id = ${team.id}`);
  // should include the member and the team-visible agent
  assert.ok(rows.length >= 2, `expected >=2 rows, got ${rows.length}`);
  const types = rows.map(r => r.actorType);
  assert.ok(types.includes("member"), "member should appear");
  assert.ok(types.includes("agent"), "team-visible agent should appear");
});
