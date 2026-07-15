/**
 * pg-repo-apps — UUID-seed pglite tests asserting the APPS domain.
 *
 * Follows the same pattern as pg-repo-sessions.test.ts:
 * - makeTestDb() → fresh in-process pglite with migrations applied.
 * - Seed helpers insert teams + actors.
 * - Each test constructs its own repo instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers, apps } from "../src/db/schema/index.js";
import { eq } from "drizzle-orm";

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedTeam(db: any, over: Record<string, any> = {}) {
  const [t] = await db
    .insert(teams)
    .values({ name: "TestTeam", slug: `test-${Date.now()}-${Math.random()}`, ...over })
    .returning();
  return t;
}

async function seedActor(db: any, teamId: string, opts: { kind?: string; userId?: string } = {}) {
  const [actor] = await db
    .insert(actors)
    .values({
      teamId,
      actorType: opts.kind ?? "member",
      displayName: "Test Actor",
      userId: opts.userId ?? `user-${Math.random()}`,
    })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return actor;
}

// ── createApp + getApp ────────────────────────────────────────────────────────

test("createApp inserts a workspace + app and returns canonical fields", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const app = await repo.createApp({
    teamId: team.id, name: "My App", type: "fullstack_tanstack_postgres", visibility: "personal",
  });

  assert.deepEqual(Object.keys(app).sort(), [
    "createdAt", "fcStatus", "fcEndpoint", "fcFunctionName", "fcRegion",
    "gitRemoteUrl", "id", "name", "provisionStatus",
    "slug", "teamId", "type", "updatedAt", "visibility", "workspaceId",
  ].sort());
  assert.equal(app.teamId, team.id);
  assert.equal(app.provisionStatus, "pending");
  assert.ok(app.workspaceId, "app must be linked to a workspace");

  const fetched = await repo.getApp(app.id);
  assert.equal(fetched.id, app.id);
});

// ── listApps / updateApp / listAppSessions ────────────────────────────────────

test("listApps hides another member's personal app but shows team apps", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedActor(db, team.id);
  const other = await seedActor(db, team.id);

  const ownerRepo = createPgBusinessRepository({ db, userId: owner.userId });
  const otherRepo = createPgBusinessRepository({ db, userId: other.userId });

  await ownerRepo.createApp({ teamId: team.id, name: "Private", type: "fullstack_tanstack_postgres", visibility: "personal" });
  await ownerRepo.createApp({ teamId: team.id, name: "Shared", type: "fullstack_tanstack_postgres", visibility: "team" });

  const ownerList = await ownerRepo.listApps({ teamId: team.id });
  const otherList = await otherRepo.listApps({ teamId: team.id });

  assert.equal(ownerList.length, 2, "owner sees both");
  assert.deepEqual(otherList.map((a) => a.name).sort(), ["Shared"], "other sees only the team app");
});

test("updateApp renames and changes visibility", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });

  const app = await repo.createApp({ teamId: team.id, name: "Before", type: "fullstack_tanstack_postgres", visibility: "personal" });
  const updated = await repo.updateApp(app.id, { name: "After", visibility: "team" });

  assert.equal(updated.name, "After");
  assert.equal(updated.visibility, "team");
});

test("listAppSessions returns only sessions linked to the app", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });
  const app = await repo.createApp({ teamId: team.id, name: "WithSessions", type: "fullstack_tanstack_postgres", visibility: "team" });

  // create a session linked to the app + one unlinked, then assert filtering
  const linked = await repo.createSession({ teamId: team.id, title: "Linked", mode: "collab", participantActorIds: [actor.id] });
  // link it to the app via a direct update (the session→app link is set elsewhere; here we verify the query filters by app_id)
  const { apps, sessions } = await import("../src/db/schema/index.js");
  const { eq } = await import("drizzle-orm");
  await db.update(sessions).set({ appId: app.id }).where(eq(sessions.id, linked.id));
  await repo.createSession({ teamId: team.id, title: "Unlinked", mode: "collab", participantActorIds: [actor.id] });

  const rows = await repo.listAppSessions(app.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Linked");
});

// ── provisionAppRepo (managed-git per-app) ────────────────────────────────────

test("createApp calls provisionAppRepo and records the git remote", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const calls: any[] = [];
  const repo = createPgBusinessRepository({
    db, userId: actor.userId,
    provisionAppRepo: async (args: any) => { calls.push(args); return { gitRemoteUrl: "https://git/x.git", gitAuthKind: "pat" }; },
  });

  const app = await repo.createApp({ teamId: team.id, name: "Z", type: "fullstack_tanstack_postgres" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].teamId, team.id);
  assert.equal(typeof calls[0].appId, "string");
  const fetched = await repo.getApp(app.id);
  assert.equal(fetched.gitRemoteUrl, "https://git/x.git");
  assert.equal(fetched.provisionStatus, "repo_created");
});

test("createApp marks provision error when provisionAppRepo throws", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({
    db, userId: actor.userId,
    provisionAppRepo: async () => { throw new Error("codeup boom"); },
  });
  const app = await repo.createApp({ teamId: team.id, name: "Z", type: "fullstack_tanstack_postgres" });
  const fetched = await repo.getApp(app.id);
  assert.equal(fetched.provisionStatus, "error");
});

// ── authz hardening ───────────────────────────────────────────────────────────

test("updateApp by a non-creator returns null and does not mutate", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedActor(db, team.id);
  const other = await seedActor(db, team.id);
  const ownerRepo = createPgBusinessRepository({ db, userId: owner.userId });
  const otherRepo = createPgBusinessRepository({ db, userId: other.userId });
  const app = await ownerRepo.createApp({ teamId: team.id, name: "Owned", type: "fullstack_tanstack_postgres", visibility: "personal" });

  const res = await otherRepo.updateApp(app.id, { name: "Hacked" });
  assert.equal(res, null);
  const still = await ownerRepo.getApp(app.id);
  assert.equal(still.name, "Owned");
});

test("listAppSessions for a personal app returns [] to a non-creator", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const owner = await seedActor(db, team.id);
  const other = await seedActor(db, team.id);
  const ownerRepo = createPgBusinessRepository({ db, userId: owner.userId });
  const otherRepo = createPgBusinessRepository({ db, userId: other.userId });
  const app = await ownerRepo.createApp({ teamId: team.id, name: "Secret", type: "fullstack_tanstack_postgres", visibility: "personal" });

  const rows = await otherRepo.listAppSessions(app.id);
  assert.deepEqual(rows, []);
});

test("createSession with appId links the session, listAppSessions finds it", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId });
  const app = await repo.createApp({ teamId: team.id, name: "Linked", type: "fullstack_tanstack_postgres", visibility: "team" });

  await repo.createSession({ teamId: team.id, title: "S1", mode: "collab", appId: app.id, participantActorIds: [actor.id] });

  const rows = await repo.listAppSessions(app.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "S1");
});

// ── getManagedGitCredential ──────────────────────────────────────────────────

test("getManagedGitCredential returns creds for a team member, null for non-member", async () => {
  const prevPat = process.env.CODEUP_PAT;
  const prevBot = process.env.CODEUP_BOT_USERNAME;
  process.env.CODEUP_PAT = "pt-secret";
  process.env.CODEUP_BOT_USERNAME = "teamclaw";
  try {
    const { db } = await makeTestDb();
    const team = await seedTeam(db);
    const member = await seedActor(db, team.id);
    const otherTeam = await seedTeam(db);
    const outsider = await seedActor(db, otherTeam.id);

    const memberRepo = createPgBusinessRepository({ db, userId: member.userId });
    const outsiderRepo = createPgBusinessRepository({ db, userId: outsider.userId });

    const cred = await memberRepo.getManagedGitCredential(team.id);
    assert.deepEqual(cred, { username: "teamclaw", token: "pt-secret" });

    const denied = await outsiderRepo.getManagedGitCredential(team.id);
    assert.equal(denied, null);
  } finally {
    if (prevPat === undefined) delete process.env.CODEUP_PAT; else process.env.CODEUP_PAT = prevPat;
    if (prevBot === undefined) delete process.env.CODEUP_BOT_USERNAME; else process.env.CODEUP_BOT_USERNAME = prevBot;
  }
});

test("getManagedGitCredential throws 503 when managed-git unconfigured", async () => {
  const prevPat = process.env.CODEUP_PAT;
  delete process.env.CODEUP_PAT;
  try {
    const { db } = await makeTestDb();
    const team = await seedTeam(db);
    const member = await seedActor(db, team.id);
    const repo = createPgBusinessRepository({ db, userId: member.userId });
    await assert.rejects(
      () => repo.getManagedGitCredential(team.id),
      (err: any) => err?.code === "managed_git_unavailable" && err?.statusCode === 503,
    );
  } finally {
    if (prevPat === undefined) delete process.env.CODEUP_PAT; else process.env.CODEUP_PAT = prevPat;
  }
});

// ── updateApp provisionStatus transitions ────────────────────────────────────

test("updateApp advances provisionStatus through legal transitions", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({
    db, userId: actor.userId,
    provisionAppRepo: async () => ({ gitRemoteUrl: "https://g/x.git", gitAuthKind: "pat" }),
  });
  const app = await repo.createApp({ teamId: team.id, name: "P", type: "fullstack_tanstack_postgres" });
  assert.equal(app.provisionStatus, "repo_created");

  const seeding = await repo.updateApp(app.id, { provisionStatus: "seeding" });
  assert.equal(seeding.provisionStatus, "seeding");
  const ready = await repo.updateApp(app.id, { provisionStatus: "ready" });
  assert.equal(ready.provisionStatus, "ready");
});

test("updateApp rejects an illegal provisionStatus jump (from pending)", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId }); // pending app
  const app = await repo.createApp({ teamId: team.id, name: "P2", type: "fullstack_tanstack_postgres" });
  assert.equal(app.provisionStatus, "pending");
  await assert.rejects(() => repo.updateApp(app.id, { provisionStatus: "ready" }), (err: any) => err?.code === "invalid_status_transition" && err?.statusCode === 400);
});

test("updateApp ignores illegal provisionStatus but still applies name", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId: actor.userId }); // pending app
  const app = await repo.createApp({ teamId: team.id, name: "Old", type: "fullstack_tanstack_postgres" });
  const updated = await repo.updateApp(app.id, { name: "New", provisionStatus: "ready" });
  assert.equal(updated.name, "New");
  assert.equal(updated.provisionStatus, "pending"); // status unchanged
});

test("deployApp moves a ready app to awaiting_build and records fc identity", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = createPgBusinessRepository({
    db, userId: "u1", callerActorId: actor.id,
    startDeploy: async () => ({
      fcFunctionName: "tc-app-x", fcRegion: "cn-hangzhou",
      ossObjectName: "apps/x/code.zip", databaseUrl: "postgres://app_x:pw@h/teamclaw_apps",
      presignedPut: "https://oss/put?sig=x",
    }),
  } as any);
  const app = await repo.createApp({ teamId: team.id, name: "Demo", type: "fullstack_tanstack_postgres" });
  // force provision_status=ready (deploy precondition)
  await db.update(apps).set({ provisionStatus: "ready" }).where(eq(apps.id, app.id));
  const out = await repo.deployApp(app.id);
  assert.equal(out.fcStatus, "awaiting_build");
  assert.equal(out.fcFunctionName, "tc-app-x");
  assert.equal(out.ossObjectName, "apps/x/code.zip");
  assert.equal(out.presignedPut, "https://oss/put?sig=x");
});

test("finalizeDeploy moves a deploying app to live and records fcEndpoint", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u1" });
  const repo = createPgBusinessRepository({
    db, userId: "u1", callerActorId: actor.id,
    startDeploy: async () => ({
      fcFunctionName: "tc-app-x", fcRegion: "cn-hangzhou",
      ossObjectName: "apps/x/code.zip", databaseUrl: "postgres://app_x:pw@h/teamclaw_apps",
      presignedPut: "https://oss/put?sig=x",
    }),
    finalizeDeploy: async ({ fcFunctionName, ossObjectName }: any) => {
      assert.equal(fcFunctionName, "tc-app-x");
      assert.match(ossObjectName, /code\.zip$/);
      return { fcEndpoint: "https://x.fcapp.run" };
    },
  } as any);
  const app = await repo.createApp({ teamId: team.id, name: "Demo", type: "fullstack_tanstack_postgres" });
  await db.update(apps).set({ provisionStatus: "ready" }).where(eq(apps.id, app.id));
  await repo.deployApp(app.id); // persists fcFunctionName + fc_status=awaiting_build
  const out = await repo.finalizeDeploy(app.id);
  assert.equal(out.fcStatus, "live");
  assert.equal(out.fcEndpoint, "https://x.fcapp.run");
});

test("deployApp rejects an app that is not yet ready", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const actor = await seedActor(db, team.id, { userId: "u2" });
  const repo = createPgBusinessRepository({ db, userId: "u2", callerActorId: actor.id,
    startDeploy: async () => ({ fcFunctionName: "x", fcRegion: "r", ossObjectName: "k", databaseUrl: "d", presignedPut: "p" }) } as any);
  const app = await repo.createApp({ teamId: team.id, name: "NotReady", type: "fullstack_tanstack_postgres" });
  // app is at provision_status 'pending'/'error' (no provisionAppRepo dep) — deploy must 409
  await assert.rejects(() => repo.deployApp(app.id), /app_not_ready|ready/i);
});
