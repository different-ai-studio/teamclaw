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
