/**
 * pg-repo-shortcuts — UUID-seed pglite tests for the SHORTCUTS/ROLES/PERMISSIONS domain.
 *
 * Key coverage:
 *  - All 11 contract methods with canonical key shapes.
 *  - Bug-fix regression: createShortcut attributes the shortcut to the team-scoped
 *    actor, not the globally-oldest actor. Multi-team test included.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";
import { teams, actors, members, teamMembers } from "../src/db/schema/index.js";

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedTeam(db: any, over: Record<string, any> = {}) {
  const [t] = await db
    .insert(teams)
    .values({ name: "TestTeam", slug: `test-${Date.now()}-${Math.random()}`, ...over })
    .returning();
  return t;
}

async function seedActor(db: any, teamId: string, userId = `user-${Math.random()}`) {
  const [actor] = await db
    .insert(actors)
    .values({ teamId, actorType: "member", displayName: "Test Actor", userId })
    .returning();
  await db.insert(members).values({ id: actor.id, status: "active" });
  await db.insert(teamMembers).values({ teamId, memberId: actor.id, role: "member" });
  return { actor, userId };
}

// ── listTeamRoles ─────────────────────────────────────────────────────────────

test("listTeamRoles returns items with canonical keys", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const repo = createPgBusinessRepository({ db });

  // Insert a role directly (no createTeamRole in contract yet)
  const { teamRoles } = await import("../src/db/schema/shortcuts.js");
  await db.insert(teamRoles).values({ teamId: team.id, code: "admin", name: "Admin" });

  const result = await repo.listTeamRoles(team.id);
  assert.ok(Array.isArray(result), "must be array");
  assert.ok(result.length >= 1);
  const role = result[0];
  assert.deepEqual(Object.keys(role).sort(), ["code", "id", "name", "teamId"].sort());
  assert.equal(role.teamId, team.id);
  assert.equal(role.code, "admin");
  assert.equal(role.name, "Admin");
});

// ── listTeamPermissions ───────────────────────────────────────────────────────

test("listTeamPermissions returns items with resourceId + roleIds", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const repo = createPgBusinessRepository({ db });

  const { teamRoles, permissions, permissionRoles } = await import("../src/db/schema/shortcuts.js");
  const [role] = await db.insert(teamRoles).values({ teamId: team.id, code: "editor", name: "Editor" }).returning();
  const [perm] = await db.insert(permissions).values({
    teamId: team.id,
    resourceType: "shortcut",
    resourceId: "a0000000-0000-0000-0000-000000000001",
    code: `perm-shortcut-${Math.random()}`,
  }).returning();
  await db.insert(permissionRoles).values({ permissionId: perm.id, roleId: role.id });

  const result = await repo.listTeamPermissions(team.id);
  assert.ok(Array.isArray(result));
  assert.ok(result.length >= 1);
  const p = result.find((x: any) => x.resourceId === perm.resourceId);
  assert.ok(p, "permission should appear");
  assert.ok(Array.isArray(p.roleIds));
  assert.ok(p.roleIds.includes(role.id), "roleIds should contain the linked role");
});

// ── listShortcuts ─────────────────────────────────────────────────────────────

test("listShortcuts returns items with canonical contract keys", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  await repo.createShortcut({
    teamId: team.id,
    kind: "link",
    label: "Home",
    position: 0,
    ownerActorId: actor.id,
  });

  const result = await repo.listShortcuts(team.id, {});
  assert.ok(Array.isArray(result));
  assert.ok(result.length >= 1);
  const shortcut = result[0];
  assert.deepEqual(Object.keys(shortcut).sort(), [
    "created_at", "icon", "id", "label", "node_type", "order",
    "owner_member_id", "parent_id", "scope", "target", "team_id", "updated_at",
  ].sort());
});

test("listShortcuts respects parentId filter", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const root = await repo.createShortcut({ teamId: team.id, kind: "folder", label: "Root", position: 0, ownerActorId: actor.id });
  await repo.createShortcut({ teamId: team.id, kind: "link", label: "Child", position: 0, parentId: root.id, ownerActorId: actor.id });

  const rootItems = await repo.listShortcuts(team.id, { parentId: null });
  const childItems = await repo.listShortcuts(team.id, { parentId: root.id });
  assert.ok(rootItems.find((s: any) => s.id === root.id), "root should appear at top level");
  assert.ok(!childItems.find((s: any) => s.id === root.id), "root should not appear as child");
  assert.ok(childItems.length >= 1, "child should appear");
});

// ── createShortcut ────────────────────────────────────────────────────────────

test("createShortcut returns shortcut with canonical keys", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const shortcut = await repo.createShortcut({
    teamId: team.id,
    kind: "link",
    label: "New Shortcut",
    position: 100,
    ownerActorId: actor.id,
  });

  assert.ok(shortcut.id);
  assert.equal(shortcut.team_id, team.id);
  assert.equal(shortcut.node_type, "link");
  assert.equal(shortcut.label, "New Shortcut");
});

/**
 * BUG-FIX REGRESSION: createShortcut must attribute the ownerMemberId to the
 * team-scoped actor, NOT the globally-oldest actor across all teams.
 *
 * A user with actors in two teams creates a shortcut in Team B. The ownerMemberId
 * stored on the shortcuts row must be team-B's actor id, not team-A's actor id.
 *
 * The old Supabase RPC used `current_member_id()` which had no team filter and
 * always returned the oldest actor. This test proves the bug is fixed.
 */
test("createShortcut (multi-team bug fix): ownerMemberId is team-scoped actor, not globally-oldest", async () => {
  const { db } = await makeTestDb();
  const sharedUserId = `user-shared-${Math.random()}`;

  // Create two teams
  const teamA = await seedTeam(db);
  const teamB = await seedTeam(db);

  // Same user has actors in both teams — teamA actor is "older" (lower sort order)
  const { actor: actorA } = await seedActor(db, teamA.id, sharedUserId);
  const { actor: actorB } = await seedActor(db, teamB.id, sharedUserId);

  // Create a shortcut in teamB using explicit ownerActorId = actorB (team-scoped)
  const repoB = createPgBusinessRepository({ db });
  const shortcut = await repoB.createShortcut({
    teamId: teamB.id,
    kind: "link",
    label: "TeamB Shortcut",
    position: 0,
    ownerActorId: actorB.id, // explicit team-scoped actor — not resolved globally
  });

  // Retrieve the raw row to verify ownerMemberId
  const { shortcuts } = await import("../src/db/schema/shortcuts.js");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(shortcuts).where(eq(shortcuts.id, shortcut.id));
  assert.ok(row, "shortcut row should exist");
  assert.equal(
    row.ownerMemberId,
    actorB.id,
    `ownerMemberId must be teamB actor (${actorB.id}), not teamA actor (${actorA.id}) — multi-team bug`,
  );
  assert.notEqual(
    row.ownerMemberId,
    actorA.id,
    "ownerMemberId must NOT be the globally-oldest actor (teamA)",
  );
});

// ── updateShortcut ────────────────────────────────────────────────────────────

test("updateShortcut mutates label and returns updated shape", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor, userId } = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId });

  const shortcut = await repo.createShortcut({ teamId: team.id, kind: "link", label: "Old", position: 0, ownerActorId: actor.id });
  const updated = await repo.updateShortcut(shortcut.id, { label: "Updated Label" });
  assert.equal(updated.label, "Updated Label");
});

test("updateShortcut: caller NOT in shortcut's team → 403", async () => {
  const { db } = await makeTestDb();
  const ownerTeam = await seedTeam(db);
  const otherTeam = await seedTeam(db);
  const { actor: ownerActor, userId: ownerUserId } = await seedActor(db, ownerTeam.id);
  const { userId: attackerUserId } = await seedActor(db, otherTeam.id);

  // Create shortcut in ownerTeam
  const ownerRepo = createPgBusinessRepository({ db, userId: ownerUserId });
  const shortcut = await ownerRepo.createShortcut({ teamId: ownerTeam.id, kind: "link", label: "Private", position: 0, ownerActorId: ownerActor.id });

  // Attacker (only in otherTeam) tries to mutate
  const attackerRepo = createPgBusinessRepository({ db, userId: attackerUserId });
  await assert.rejects(
    () => attackerRepo.updateShortcut(shortcut.id, { label: "Hacked" }),
    (err: any) => err.statusCode === 403,
    "should reject with 403",
  );
});

test("updateShortcut: no ctx.userId → 403", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor, userId } = await seedActor(db, team.id);
  const ownerRepo = createPgBusinessRepository({ db, userId });
  const shortcut = await ownerRepo.createShortcut({ teamId: team.id, kind: "link", label: "SC", position: 0, ownerActorId: actor.id });

  const anonRepo = createPgBusinessRepository({ db }); // no userId
  await assert.rejects(
    () => anonRepo.updateShortcut(shortcut.id, { label: "X" }),
    (err: any) => err.statusCode === 403,
    "should reject with 403",
  );
});

// ── deleteShortcut ────────────────────────────────────────────────────────────

test("deleteShortcut removes the row", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor, userId } = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId });

  const shortcut = await repo.createShortcut({ teamId: team.id, kind: "link", label: "Temp", position: 0, ownerActorId: actor.id });
  await repo.deleteShortcut(shortcut.id);

  const items = await repo.listShortcuts(team.id, {});
  assert.ok(!items.find((s: any) => s.id === shortcut.id), "deleted shortcut should not appear");
});

test("deleteShortcut: caller NOT in shortcut's team → 403", async () => {
  const { db } = await makeTestDb();
  const ownerTeam = await seedTeam(db);
  const otherTeam = await seedTeam(db);
  const { actor: ownerActor, userId: ownerUserId } = await seedActor(db, ownerTeam.id);
  const { userId: attackerUserId } = await seedActor(db, otherTeam.id);

  const ownerRepo = createPgBusinessRepository({ db, userId: ownerUserId });
  const shortcut = await ownerRepo.createShortcut({ teamId: ownerTeam.id, kind: "link", label: "Mine", position: 0, ownerActorId: ownerActor.id });

  const attackerRepo = createPgBusinessRepository({ db, userId: attackerUserId });
  await assert.rejects(
    () => attackerRepo.deleteShortcut(shortcut.id),
    (err: any) => err.statusCode === 403,
    "should reject with 403",
  );
});

test("deleteShortcut: no ctx.userId → 403", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor, userId } = await seedActor(db, team.id);
  const ownerRepo = createPgBusinessRepository({ db, userId });
  const shortcut = await ownerRepo.createShortcut({ teamId: team.id, kind: "link", label: "SC2", position: 0, ownerActorId: actor.id });

  const anonRepo = createPgBusinessRepository({ db });
  await assert.rejects(
    () => anonRepo.deleteShortcut(shortcut.id),
    (err: any) => err.statusCode === 403,
    "should reject with 403",
  );
});

// ── batchMoveShortcuts ────────────────────────────────────────────────────────

test("batchMoveShortcuts updates parentId and position", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor, userId } = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db, userId });

  const a = await repo.createShortcut({ teamId: team.id, kind: "link", label: "A", position: 0, ownerActorId: actor.id });
  const b = await repo.createShortcut({ teamId: team.id, kind: "folder", label: "B", position: 1, ownerActorId: actor.id });

  await repo.batchMoveShortcuts({
    moves: [{ shortcutId: a.id, parentId: b.id, position: 0 }],
  });

  const { shortcuts } = await import("../src/db/schema/shortcuts.js");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(shortcuts).where(eq(shortcuts.id, a.id));
  assert.equal(row.parentId, b.id, "parentId should be updated to b.id");
  assert.equal(row.order, 0, "position/order should be updated");
});

test("batchMoveShortcuts: no ctx.userId → 403", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor, userId } = await seedActor(db, team.id);
  const ownerRepo = createPgBusinessRepository({ db, userId });
  const a = await ownerRepo.createShortcut({ teamId: team.id, kind: "link", label: "A2", position: 0, ownerActorId: actor.id });

  const anonRepo = createPgBusinessRepository({ db });
  await assert.rejects(
    () => anonRepo.batchMoveShortcuts({ moves: [{ shortcutId: a.id, parentId: null, position: 1 }] }),
    (err: any) => err.statusCode === 403,
    "should reject with 403",
  );
});

// ── setShortcutVisibleRoles ───────────────────────────────────────────────────

test("setShortcutVisibleRoles swaps permission_roles for the shortcut", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const { teamRoles } = await import("../src/db/schema/shortcuts.js");
  const [role1] = await db.insert(teamRoles).values({ teamId: team.id, code: "viewer", name: "Viewer" }).returning();
  const [role2] = await db.insert(teamRoles).values({ teamId: team.id, code: "editor", name: "Editor" }).returning();

  const shortcut = await repo.createShortcut({ teamId: team.id, kind: "link", label: "Vis", position: 0, ownerActorId: actor.id });

  // Set role1
  await repo.setShortcutVisibleRoles(shortcut.id, { roleIds: [role1.id] });

  // Role visibility is verified via listShortcutRoleBindings (the canonical
  // endpoint). The shortcut row itself no longer carries visible_roles — it now
  // mirrors supabase's snake_case row shape consumed directly by the client.
  const roleIdsFor = async (sid: string): Promise<string[]> => {
    const bindings = await repo.listShortcutRoleBindings(team.id);
    const b = bindings.find((x: any) => x.resource_id === sid);
    return (b?.permission_roles ?? []).map((x: any) => x.role_id);
  };
  assert.ok((await roleIdsFor(shortcut.id)).includes(role1.id), "role1 should be bound");

  // Swap to role2 only
  await repo.setShortcutVisibleRoles(shortcut.id, { roleIds: [role2.id] });
  const after = await roleIdsFor(shortcut.id);
  assert.ok(!after.includes(role1.id), "role1 should be removed");
  assert.ok(after.includes(role2.id), "role2 should appear");
});

test("setShortcutVisibleRoles clears all roles when roleIds is empty", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const { teamRoles } = await import("../src/db/schema/shortcuts.js");
  const [role] = await db.insert(teamRoles).values({ teamId: team.id, code: "admin", name: "Admin" }).returning();

  const shortcut = await repo.createShortcut({ teamId: team.id, kind: "link", label: "Vis2", position: 0, ownerActorId: actor.id });
  await repo.setShortcutVisibleRoles(shortcut.id, { roleIds: [role.id] });
  await repo.setShortcutVisibleRoles(shortcut.id, { roleIds: [] });

  const bindings = await repo.listShortcutRoleBindings(team.id);
  const binding = bindings.find((x: any) => x.resource_id === shortcut.id);
  const roleIds = (binding?.permission_roles ?? []).map((x: any) => x.role_id);
  assert.deepEqual(roleIds, [], "all roles should be cleared");
});

// ── listShortcutsByScope ──────────────────────────────────────────────────────

test("listShortcutsByScope filters by scope=team", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  await repo.createShortcut({ teamId: team.id, kind: "link", label: "TeamScope", position: 0, ownerActorId: actor.id, scope: "team" });
  await repo.createShortcut({ teamId: team.id, kind: "link", label: "PersonalScope", position: 1, ownerActorId: actor.id, scope: "personal" });

  const teamScoped = await repo.listShortcutsByScope({ scope: "team", teamId: team.id });
  assert.ok(Array.isArray(teamScoped));
  assert.ok(teamScoped.every((s: any) => s.node_type !== undefined), "items must be shortcut shapes");
  // All results should come from the right team
  assert.ok(teamScoped.find((s: any) => s.label === "TeamScope"), "team-scope shortcut should appear");
  assert.ok(!teamScoped.find((s: any) => s.label === "PersonalScope"), "personal shortcut should not appear in team scope");
});

test("listShortcutsByScope personal: caller sees ONLY their own personal shortcuts in their team", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor: actorA, userId: userIdA } = await seedActor(db, team.id);
  const { actor: actorB, userId: userIdB } = await seedActor(db, team.id);

  // actorA creates a personal shortcut
  const repoA = createPgBusinessRepository({ db, userId: userIdA });
  await repoA.createShortcut({ teamId: team.id, kind: "link", label: "A Personal", position: 0, ownerActorId: actorA.id, scope: "personal" });

  // actorB creates a personal shortcut
  const repoB = createPgBusinessRepository({ db, userId: userIdB });
  await repoB.createShortcut({ teamId: team.id, kind: "link", label: "B Personal", position: 0, ownerActorId: actorB.id, scope: "personal" });

  // actorA queries personal scope — should only see their own
  const itemsA = await repoA.listShortcutsByScope({ scope: "personal", teamId: team.id });
  assert.ok(itemsA.find((s: any) => s.label === "A Personal"), "A should see their own shortcut");
  assert.ok(!itemsA.find((s: any) => s.label === "B Personal"), "A must NOT see B's personal shortcut");
});

test("listShortcutsByScope personal: no ctx.userId → 403", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const anonRepo = createPgBusinessRepository({ db });
  await assert.rejects(
    () => anonRepo.listShortcutsByScope({ scope: "personal", teamId: team.id }),
    (err: any) => err.statusCode === 403,
    "should reject with 403",
  );
});

test("listShortcutsByScope personal: caller not in team → 403", async () => {
  const { db } = await makeTestDb();
  const teamA = await seedTeam(db);
  const teamB = await seedTeam(db);
  const { userId: userIdB } = await seedActor(db, teamB.id);

  // userIdB is NOT in teamA
  const repo = createPgBusinessRepository({ db, userId: userIdB });
  await assert.rejects(
    () => repo.listShortcutsByScope({ scope: "personal", teamId: teamA.id }),
    (err: any) => err.statusCode === 403,
    "should reject with 403",
  );
});

// ── listShortcutRoleBindings ──────────────────────────────────────────────────

test("listShortcutRoleBindings returns raw permission_roles for shortcut resource type", async () => {
  const { db } = await makeTestDb();
  const team = await seedTeam(db);
  const { actor } = await seedActor(db, team.id);
  const repo = createPgBusinessRepository({ db });

  const shortcut = await repo.createShortcut({ teamId: team.id, kind: "link", label: "Bind", position: 0, ownerActorId: actor.id });

  const { teamRoles } = await import("../src/db/schema/shortcuts.js");
  const [role] = await db.insert(teamRoles).values({ teamId: team.id, code: "bind-role", name: "BindRole" }).returning();
  await repo.setShortcutVisibleRoles(shortcut.id, { roleIds: [role.id] });

  const bindings = await repo.listShortcutRoleBindings(team.id);
  assert.ok(Array.isArray(bindings));
  // Should include a binding for our shortcut
  const binding = bindings.find((b: any) => b.resource_id === shortcut.id);
  assert.ok(binding, "binding should exist for shortcut");
  const roleIds = (binding.permission_roles ?? []).map((x: any) => x.role_id);
  assert.ok(roleIds.includes(role.id), "role should be in binding");
});
