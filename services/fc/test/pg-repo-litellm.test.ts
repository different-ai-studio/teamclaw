/**
 * pg-repo-litellm.test.ts
 *
 * Tests for:
 *   - setupLiteLlm (with injected stub provisioner)
 *   - loadTeamWorkspaceGitConfig / saveTeamWorkspaceGitConfig round-trip
 *   - listActorDirectoryForSync
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./db/pglite.js";
import { createPgBusinessRepository } from "../src/lib/pg-repo/index.js";

// Stable UUIDs
const TEAM_A = "b0000000-0000-0000-0000-000000000001";
const TEAM_B = "b0000000-0000-0000-0000-000000000002";
const TEAM_C = "b0000000-0000-0000-0000-000000000003";
const ACTOR_1 = "c0000000-0000-0000-0000-000000000001";

async function seedTeam(pg: any, id: string, name = "Test Team", slug = "test-slug") {
  await pg.exec(
    `INSERT INTO teams (id, slug, name, created_at, updated_at)
     VALUES ('${id}', '${slug}', '${name}', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedActor(pg: any, id: string, teamId: string, type = "member") {
  await pg.exec(
    `INSERT INTO actors (id, team_id, actor_type, display_name, created_at, updated_at)
     VALUES ('${id}', '${teamId}', '${type}', 'Actor One', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedActorForUser(pg: any, id: string, teamId: string, userId: string, type = "member") {
  await pg.exec(
    `INSERT INTO actors (id, team_id, user_id, actor_type, display_name, created_at, updated_at)
     VALUES ('${id}', '${teamId}', '${userId}', '${type}', 'Actor One', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
}

// Stub provisioner for tests
function makeStubProvisioner(override?: Partial<{ litellmTeamId: string; aiGatewayEndpoint: string; litellmKey: string }>) {
  return async (_teamName: string) => ({
    litellmTeamId: override?.litellmTeamId ?? "lt-test-123",
    aiGatewayEndpoint: override?.aiGatewayEndpoint ?? "https://gw.example.com/litellm",
    litellmKey: override?.litellmKey ?? "sk-litellm-test-key",
  });
}

// ── setupLiteLlm ──────────────────────────────────────────────────────────────

test("pg-repo [litellm]: setupLiteLlm returns aiGatewayEndpoint and litellmKey", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Acme Corp", "acme-corp");

  const repo = createPgBusinessRepository({ db, provisionLiteLlm: makeStubProvisioner() });
  const out = await repo.setupLiteLlm(TEAM_A);

  assert.ok(out, "result must be returned");
  assert.equal(typeof out.aiGatewayEndpoint, "string");
  assert.ok(out.aiGatewayEndpoint.length > 0, "aiGatewayEndpoint must be non-empty");
  assert.equal(typeof out.litellmKey, "string");
  assert.ok(out.litellmKey.length > 0, "litellmKey must be non-empty");
  assert.equal(out.aiGatewayEndpoint, "https://gw.example.com/litellm");
  assert.equal(out.litellmKey, "sk-litellm-test-key");
});

test("pg-repo [litellm]: setupLiteLlm persists litellmTeamId + aiGatewayEndpoint to team_workspace_config", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Acme Corp", "acme-corp-2");

  const repo = createPgBusinessRepository({ db, provisionLiteLlm: makeStubProvisioner() });
  await repo.setupLiteLlm(TEAM_A);

  // Read back via getWorkspaceConfig to verify persistence
  const cfg = await repo.getWorkspaceConfig(TEAM_A);
  assert.ok(cfg, "workspace config must exist after setupLiteLlm");
  assert.equal(cfg.litellmTeamId, "lt-test-123");
});

test("pg-repo [litellm]: setupLiteLlm throws 503 when no provisioner injected", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_B, "No Provisioner Team", "no-prov");

  const repo = createPgBusinessRepository({ db }); // no provisionLiteLlm
  await assert.rejects(
    () => repo.setupLiteLlm(TEAM_B),
    (err: any) => err?.statusCode === 503 || err?.code === "litellm_unavailable",
  );
});

test("pg-repo [litellm]: setupLiteLlm throws 404 for nonexistent team", async () => {
  const { db } = await makeTestDb();

  const repo = createPgBusinessRepository({ db, provisionLiteLlm: makeStubProvisioner() });
  await assert.rejects(
    () => repo.setupLiteLlm("00000000-0000-0000-0000-000000000000"),
    (err: any) => err?.statusCode === 404 || err?.code === "not_found",
  );
});

// ── ensureMemberKey ───────────────────────────────────────────────────────────

function stubLitellmFetch(routes: Record<string, (init: any) => { status: number; body: any }>) {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const path = new URL(url).pathname + (new URL(url).search || "");
    const match = Object.keys(routes).find((r) => path.startsWith(r));
    const { status, body } = match ? routes[match](init) : { status: 404, body: {} };
    return { ok: status < 400, status, text: async () => JSON.stringify(body) } as any;
  }) as any;
  return calls;
}

test("pg-repo [litellm]: ensureMemberKey returns caller's own sk-tc key when litellmTeamId already set", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  stubLitellmFetch({
    "/key/info": () => ({ status: 200, body: { info: { key_name: `sk-tc-${ACTOR_1}`.slice(0, 46) } } }),
  });

  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Key Team", "key-team");
  const userId = "d0000000-0000-0000-0000-000000000001";
  await seedActorForUser(pg, ACTOR_1, TEAM_A, userId);

  const repo = createPgBusinessRepository({ db, userId, provisionLiteLlm: makeStubProvisioner() });
  await repo.setupLiteLlm(TEAM_A); // pre-provision, so ensureMemberKey should NOT re-provision

  const out = await repo.ensureMemberKey(TEAM_A);
  assert.equal(out.key, `sk-tc-${ACTOR_1}`.slice(0, 46));
  assert.ok(typeof out.aiGatewayEndpoint === "string" && out.aiGatewayEndpoint.length > 0);
});

test("pg-repo [litellm]: ensureMemberKey auto-provisions (A2-1) when litellmTeamId absent, using the persisted/returned id", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  stubLitellmFetch({
    "/key/info": () => ({ status: 404, body: {} }),
    "/key/generate": () => ({ status: 200, body: { key: `sk-tc-${ACTOR_1}`.slice(0, 46) } }),
  });

  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_B, "Auto Team", "auto-team");
  const userId = "d0000000-0000-0000-0000-000000000002";
  await seedActorForUser(pg, ACTOR_1, TEAM_B, userId);

  const repo = createPgBusinessRepository({
    db,
    userId,
    provisionLiteLlm: makeStubProvisioner({ litellmTeamId: "lt-auto-generated" }),
  });

  const out = await repo.ensureMemberKey(TEAM_B);
  assert.equal(out.key, `sk-tc-${ACTOR_1}`.slice(0, 46));

  const cfg = await repo.getWorkspaceConfig(TEAM_B);
  assert.equal(cfg.litellmTeamId, "lt-auto-generated");
});

test("pg-repo [litellm]: ensureMemberKey rejects non-member with 403", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_C, "Outsider Team", "outsider-team");

  const repo = createPgBusinessRepository({ db, userId: "d0000000-0000-0000-0000-000000000099", provisionLiteLlm: makeStubProvisioner() });
  await assert.rejects(
    () => repo.ensureMemberKey(TEAM_C),
    (err: any) => err?.statusCode === 403 && err?.code === "forbidden",
  );
});

test("pg-repo [litellm]: ensureMemberKey rejects unauthenticated caller with 401", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Anon Team", "anon-team");

  const repo = createPgBusinessRepository({ db, provisionLiteLlm: makeStubProvisioner() });
  await assert.rejects(
    () => repo.ensureMemberKey(TEAM_A),
    (err: any) => err?.statusCode === 401 && err?.code === "missing_auth",
  );
});

// ── listLiteLlmKeys ───────────────────────────────────────────────────────────

test("pg-repo [litellm]: listLiteLlmKeys returns masked keys using the persisted litellmTeamId", async () => {
  stubLitellmFetch({
    "/team/info": () => ({
      status: 200,
      body: {
        keys: [
          { token: "sk-abcdefghijklmnop", key_alias: "member-1", spend: 1.5, created_at: "2026-06-01T00:00:00Z" },
        ],
      },
    }),
  });

  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Keys Team", "keys-team");
  const userId = "d0000000-0000-0000-0000-000000000010";
  await seedActorForUser(pg, ACTOR_1, TEAM_A, userId);

  const repo = createPgBusinessRepository({ db, userId, provisionLiteLlm: makeStubProvisioner({ litellmTeamId: "lt-keys-team" }) });
  await repo.setupLiteLlm(TEAM_A); // persists litellmTeamId

  const out = await repo.listLiteLlmKeys(TEAM_A);
  assert.deepEqual(out, {
    teamId: "lt-keys-team",
    keys: [{ key: "sk-abcdefg...", alias: "member-1", spend: 1.5, created_at: "2026-06-01T00:00:00Z" }],
  });
});

test("pg-repo [litellm]: listLiteLlmKeys returns { teamId: null, keys: [] } without calling LiteLLM when litellmTeamId absent", async () => {
  const calls = stubLitellmFetch({});

  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_B, "No Keys Team", "no-keys-team");
  const userId = "d0000000-0000-0000-0000-000000000011";
  await seedActorForUser(pg, ACTOR_1, TEAM_B, userId);

  const repo = createPgBusinessRepository({ db, userId });
  const out = await repo.listLiteLlmKeys(TEAM_B);
  assert.deepEqual(out, { teamId: null, keys: [] });
  assert.equal(calls.length, 0, "must not call LiteLLM when no litellmTeamId is persisted");
});

test("pg-repo [litellm]: listLiteLlmKeys rejects non-member with 403", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_C, "Outsider Keys Team", "outsider-keys-team");

  const repo = createPgBusinessRepository({ db, userId: "d0000000-0000-0000-0000-000000000098" });
  await assert.rejects(
    () => repo.listLiteLlmKeys(TEAM_C),
    (err: any) => err?.statusCode === 403 && err?.code === "forbidden",
  );
});

test("pg-repo [litellm]: listLiteLlmKeys rejects unauthenticated caller with 401", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Anon Keys Team", "anon-keys-team");

  const repo = createPgBusinessRepository({ db });
  await assert.rejects(
    () => repo.listLiteLlmKeys(TEAM_A),
    (err: any) => err?.statusCode === 401 && err?.code === "missing_auth",
  );
});

// ── setLiteLlmBudget ──────────────────────────────────────────────────────────

test("pg-repo [litellm]: setLiteLlmBudget calls LiteLLM team/update with persisted litellmTeamId and returns maxBudget", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  const calls = stubLitellmFetch({
    "/team/update": (init: any) => ({ status: 200, body: JSON.parse(init.body) }),
  });

  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Budget Team", "budget-team");
  const userId = "d0000000-0000-0000-0000-000000000020";
  await seedActorForUser(pg, ACTOR_1, TEAM_A, userId);
  await pg.exec(`INSERT INTO members (id, status) VALUES ('${ACTOR_1}', 'active')`);
  await pg.exec(
    `INSERT INTO team_members (team_id, member_id, role) VALUES ('${TEAM_A}', '${ACTOR_1}', 'owner')`,
  );

  const repo = createPgBusinessRepository({ db, userId, provisionLiteLlm: makeStubProvisioner({ litellmTeamId: "lt-budget-team" }) });
  await repo.setupLiteLlm(TEAM_A); // persists litellmTeamId

  const out = await repo.setLiteLlmBudget(TEAM_A, { maxBudget: 25 });
  assert.deepEqual(out, { maxBudget: 25 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
});

test("pg-repo [litellm]: setLiteLlmBudget rejects non-owner with 403", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_B, "Non Owner Budget Team", "non-owner-budget-team");
  const userId = "d0000000-0000-0000-0000-000000000021";
  await seedActorForUser(pg, ACTOR_1, TEAM_B, userId);
  await pg.exec(`INSERT INTO members (id, status) VALUES ('${ACTOR_1}', 'active')`);
  await pg.exec(
    `INSERT INTO team_members (team_id, member_id, role) VALUES ('${TEAM_B}', '${ACTOR_1}', 'member')`,
  );

  const repo = createPgBusinessRepository({ db, userId });
  await assert.rejects(
    () => repo.setLiteLlmBudget(TEAM_B, { maxBudget: 25 }),
    (err: any) => err?.statusCode === 403 && err?.code === "forbidden",
  );
});

test("pg-repo [litellm]: setLiteLlmBudget throws 409 litellm_not_provisioned when litellmTeamId is unset", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_C, "Unprovisioned Budget Team", "unprovisioned-budget-team");
  const userId = "d0000000-0000-0000-0000-000000000022";
  await seedActorForUser(pg, ACTOR_1, TEAM_C, userId);
  await pg.exec(`INSERT INTO members (id, status) VALUES ('${ACTOR_1}', 'active')`);
  await pg.exec(
    `INSERT INTO team_members (team_id, member_id, role) VALUES ('${TEAM_C}', '${ACTOR_1}', 'owner')`,
  );

  const repo = createPgBusinessRepository({ db, userId });
  await assert.rejects(
    () => repo.setLiteLlmBudget(TEAM_C, { maxBudget: 25 }),
    (err: any) => err?.statusCode === 409 && err?.code === "litellm_not_provisioned",
  );
});

test("pg-repo [litellm]: setLiteLlmBudget throws 400 missing_maxBudget when maxBudget is absent", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Missing Budget Team", "missing-budget-team");
  const userId = "d0000000-0000-0000-0000-000000000023";
  await seedActorForUser(pg, ACTOR_1, TEAM_A, userId);
  await pg.exec(`INSERT INTO members (id, status) VALUES ('${ACTOR_1}', 'active')`);
  await pg.exec(
    `INSERT INTO team_members (team_id, member_id, role) VALUES ('${TEAM_A}', '${ACTOR_1}', 'owner')`,
  );

  const repo = createPgBusinessRepository({ db, userId, provisionLiteLlm: makeStubProvisioner() });
  await repo.setupLiteLlm(TEAM_A);

  await assert.rejects(
    () => repo.setLiteLlmBudget(TEAM_A, {}),
    (err: any) => err?.statusCode === 400 && err?.code === "missing_maxBudget",
  );
});

// ── loadTeamWorkspaceGitConfig / saveTeamWorkspaceGitConfig ───────────────────

test("pg-repo [litellm]: loadTeamWorkspaceGitConfig returns null when absent", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_B, "No Config Team", "no-config-team");

  const repo = createPgBusinessRepository({ db });
  const cfg = await repo.loadTeamWorkspaceGitConfig(TEAM_B);
  assert.equal(cfg, null);
});

test("pg-repo [litellm]: saveTeamWorkspaceGitConfig + loadTeamWorkspaceGitConfig round-trip", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_C, "Git Team", "git-team");

  const repo = createPgBusinessRepository({ db });

  // Save using snake_case keys (as supabase-repo does)
  await repo.saveTeamWorkspaceGitConfig({
    team_id: TEAM_C,
    git_url: "https://example.com/team/repo.git",
    git_branch: "main",
    git_token: "tok-secret",
    ai_gateway_endpoint: "https://gw.example.com",
    enabled: true,
  });

  const cfg = await repo.loadTeamWorkspaceGitConfig(TEAM_C);
  assert.ok(cfg, "config must be returned after save");
  assert.equal(cfg.team_id, TEAM_C);
  assert.equal(cfg.git_url, "https://example.com/team/repo.git");
  assert.equal(cfg.git_branch, "main");
  assert.equal(cfg.git_token, "tok-secret");
  assert.equal(cfg.ai_gateway_endpoint, "https://gw.example.com");
  assert.equal(cfg.enabled, true);
});

test("pg-repo [litellm]: saveTeamWorkspaceGitConfig is idempotent (upsert)", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_C, "Git Team 2", "git-team-2");

  const repo = createPgBusinessRepository({ db });

  await repo.saveTeamWorkspaceGitConfig({ team_id: TEAM_C, git_url: "https://first.example.com/repo.git" });
  await repo.saveTeamWorkspaceGitConfig({ team_id: TEAM_C, git_url: "https://second.example.com/repo.git" });

  const cfg = await repo.loadTeamWorkspaceGitConfig(TEAM_C);
  assert.ok(cfg, "config must exist after upsert");
  assert.equal(cfg.git_url, "https://second.example.com/repo.git");
});

// ── listActorDirectoryForSync ─────────────────────────────────────────────────

test("pg-repo [litellm]: listActorDirectoryForSync returns actors for team", async () => {
  const { db, pg } = await makeTestDb();
  await seedTeam(pg, TEAM_A, "Sync Team", "sync-team");
  await seedActor(pg, ACTOR_1, TEAM_A);

  const repo = createPgBusinessRepository({ db });
  const rows = await repo.listActorDirectoryForSync(TEAM_A, null);

  assert.ok(Array.isArray(rows), "result must be an array");
  assert.ok(rows.length >= 1, "must return at least one actor");

  const row = rows[0];
  assert.equal(row.id, ACTOR_1);
  assert.equal(row.team_id, TEAM_A);
  assert.equal(row.actor_type, "member");
  assert.equal(typeof row.display_name, "string");
  assert.ok("created_at" in row, "created_at must be present");
  assert.ok("updated_at" in row, "updated_at must be present");
});

test("pg-repo [litellm]: listActorDirectoryForSync returns empty for unknown team", async () => {
  const { db } = await makeTestDb();

  const repo = createPgBusinessRepository({ db });
  const rows = await repo.listActorDirectoryForSync("00000000-0000-0000-0000-000000000000", null);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 0);
});

// ── getLiteLlmUsage attribution ───────────────────────────────────────────────
//
// Daemons burn the tokens, so usage grouped by spending key reads as a list of
// machines. These exercise the real Drizzle join (actors → agents → owner) that
// rolls that spend up to the accountable human.

const HUMAN_ACTOR = "c0000000-0000-0000-0000-0000000000a1";
const DAEMON_ACTOR = "c0000000-0000-0000-0000-0000000000a2";
const OUTSIDER_ACTOR = "c0000000-0000-0000-0000-0000000000a3";

async function seedDaemon(pg: any, id: string, teamId: string, ownerMemberId: string, name = "Mac-mini-3") {
  await pg.exec(
    `INSERT INTO actors (id, team_id, actor_type, display_name, created_at, updated_at)
     VALUES ('${id}', '${teamId}', 'agent', '${name}', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
  await pg.exec(
    `INSERT INTO agents (id, agent_kind, status, visibility, owner_member_id)
     VALUES ('${id}', 'daemon', 'offline', 'personal', '${ownerMemberId}')
     ON CONFLICT (id) DO NOTHING`,
  );
}

/** Seed a team whose owner is a human with one daemon, and provision LiteLLM. */
async function seedAttributionTeam(pg: any, db: any, teamId: string, userId: string) {
  await seedTeam(pg, teamId, "Attribution Team", `attribution-${teamId.slice(-4)}`);
  await pg.exec(
    `INSERT INTO actors (id, team_id, user_id, actor_type, display_name, created_at, updated_at)
     VALUES ('${HUMAN_ACTOR}', '${teamId}', '${userId}', 'member', '周金亮', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
  await pg.exec(`INSERT INTO members (id, status) VALUES ('${HUMAN_ACTOR}', 'active')`);
  await pg.exec(
    `INSERT INTO team_members (team_id, member_id, role) VALUES ('${teamId}', '${HUMAN_ACTOR}', 'owner')`,
  );
  await seedDaemon(pg, DAEMON_ACTOR, teamId, HUMAN_ACTOR);
}

test("pg-repo [litellm]: getLiteLlmUsage attributes daemon spend to the owning human", async () => {
  const { db, pg } = await makeTestDb();
  const userId = "d0000000-0000-0000-0000-0000000000a1";
  await seedAttributionTeam(pg, db, TEAM_A, userId);

  const repo = createPgBusinessRepository({
    db,
    userId,
    provisionLiteLlm: makeStubProvisioner({ litellmTeamId: "lt-attrib" }),
    // The daemon spends under its OWN agent-actor key — this is the real shape.
    queryLiteLlmUsage: async () => ({
      litellmTeamId: "lt-attrib",
      range: "month",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      startUtc: "2026-06-30T16:00:00.000Z",
      endUtc: "2026-07-31T16:00:00.000Z",
      summary: { totalTokens: 100, promptTokens: 60, completionTokens: 40, totalSpend: 3, requestCount: 5 },
      maxBudget: 10,
      members: [
        { apiKey: "h1", alias: "member-c0000000", actorId: DAEMON_ACTOR, tokens: 90, spend: 2, requests: 4 },
        { apiKey: "h2", alias: "member-c0000000", actorId: HUMAN_ACTOR, tokens: 10, spend: 1, requests: 1 },
      ],
      byModel: [],
    }),
  });
  await repo.setupLiteLlm(TEAM_A);

  const out = await repo.getLiteLlmUsage(TEAM_A, {}, { userId });

  assert.equal(out.members.length, 1, "the daemon's spend merges into its owner's row");
  assert.equal(out.members[0].actorId, HUMAN_ACTOR);
  assert.equal(out.members[0].displayName, "周金亮", "a person's name, not member-<hex>");
  assert.equal(out.members[0].spend, 3);
  assert.equal(out.members[0].tokens, 100);
  assert.equal(out.members[0].requests, 5);
});

test("pg-repo [litellm]: getLiteLlmUsage reports unresolvable keys as unattributed, preserving spend", async () => {
  // Exactly the live failure: keys minted before an actor-id rebaseline point at
  // actors that no longer exist. Their spend is real and must not vanish.
  const { db, pg } = await makeTestDb();
  const userId = "d0000000-0000-0000-0000-0000000000a2";
  await seedAttributionTeam(pg, db, TEAM_B, userId);

  const repo = createPgBusinessRepository({
    db,
    userId,
    provisionLiteLlm: makeStubProvisioner({ litellmTeamId: "lt-orphan" }),
    queryLiteLlmUsage: async () => ({
      litellmTeamId: "lt-orphan",
      range: "month",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      startUtc: "2026-06-30T16:00:00.000Z",
      endUtc: "2026-07-31T16:00:00.000Z",
      summary: { totalTokens: 200, promptTokens: 100, completionTokens: 100, totalSpend: 9, requestCount: 6 },
      maxBudget: 10,
      members: [
        // Orphaned actor id, a key with no user_id at all, and a non-uuid —
        // the last one would make Postgres raise 22P02 if passed through.
        { apiKey: "h1", alias: "member-78f9a657", actorId: "78f9a657-0000-4000-8000-000000000000", tokens: 100, spend: 5, requests: 3 },
        { apiKey: "h2", alias: "sk-abcdefgh…", actorId: null, tokens: 50, spend: 3, requests: 2 },
        { apiKey: "h3", alias: "legacy", actorId: "not-a-uuid", tokens: 10, spend: 0.5, requests: 0 },
        { apiKey: "h4", alias: "member-c0000000", actorId: HUMAN_ACTOR, tokens: 40, spend: 0.5, requests: 1 },
      ],
      byModel: [],
    }),
  });
  await repo.setupLiteLlm(TEAM_B);

  const out = await repo.getLiteLlmUsage(TEAM_B, {}, { userId });

  assert.equal(out.members.length, 2);
  assert.equal(out.members[0].actorId, HUMAN_ACTOR, "resolved people rank first");
  const un = out.members[1];
  assert.equal(un.actorId, null);
  assert.equal(un.displayName, null, "client renders the localized label");
  assert.equal(un.spend, 8.5, "all three unresolvable keys pool together");
  assert.equal(
    out.members.reduce((s: number, m: any) => s + m.spend, 0),
    9,
    "rows still sum to the team total",
  );
});

test("pg-repo [litellm]: getLiteLlmUsage never resolves an actor from another team", async () => {
  // Actor ids arrive from LiteLLM, so an unscoped lookup would leak a stranger's
  // display name into this team's leaderboard.
  const { db, pg } = await makeTestDb();
  const userId = "d0000000-0000-0000-0000-0000000000a3";
  await seedAttributionTeam(pg, db, TEAM_A, userId);
  await seedTeam(pg, TEAM_C, "Other Team", "other-team");
  await pg.exec(
    `INSERT INTO actors (id, team_id, actor_type, display_name, created_at, updated_at)
     VALUES ('${OUTSIDER_ACTOR}', '${TEAM_C}', 'member', 'Someone Else', NOW(), NOW())`,
  );
  await pg.exec(`INSERT INTO members (id, status) VALUES ('${OUTSIDER_ACTOR}', 'active')`);

  const repo = createPgBusinessRepository({
    db,
    userId,
    provisionLiteLlm: makeStubProvisioner({ litellmTeamId: "lt-scope" }),
    queryLiteLlmUsage: async () => ({
      litellmTeamId: "lt-scope",
      range: "month",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      startUtc: "2026-06-30T16:00:00.000Z",
      endUtc: "2026-07-31T16:00:00.000Z",
      summary: { totalTokens: 10, promptTokens: 5, completionTokens: 5, totalSpend: 1, requestCount: 1 },
      maxBudget: 10,
      members: [{ apiKey: "h1", alias: "member-c0000000", actorId: OUTSIDER_ACTOR, tokens: 10, spend: 1, requests: 1 }],
      byModel: [],
    }),
  });
  await repo.setupLiteLlm(TEAM_A);

  const out = await repo.getLiteLlmUsage(TEAM_A, {}, { userId });

  assert.equal(out.members.length, 1);
  assert.equal(out.members[0].actorId, null, "out-of-team actor must not resolve");
  assert.equal(out.members[0].displayName, null, "must not leak 'Someone Else'");
});
