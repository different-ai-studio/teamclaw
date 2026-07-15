import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

// GET /v1/teams?scope=all is a bearer route, so it resolves the BUSINESS
// repository (createRepository). POST /v1/teams/:id/activate is registered with
// { auth: "none" }, so it resolves the AUTH repository (createAuthRepository) —
// which owns switchActiveTeam (it forwards the bearer itself).
function makeApp({
  listAllMyTeams,
  switchActiveTeam,
}: {
  listAllMyTeams?: (...args: any[]) => any;
  switchActiveTeam?: (...args: any[]) => any;
}) {
  return createApp({
    createRepository: ({ accessToken }: { accessToken: string }) => ({
      listTeams: async () => [{ id: "active-only", name: "Active", accessToken }],
      listAllMyTeams,
    }),
    createAuthRepository: () => ({
      switchActiveTeam,
    }),
  } as any);
}

test("GET /v1/teams?scope=all calls listAllMyTeams and returns orgName", async () => {
  let called = false;
  const app = makeApp({
    listAllMyTeams: async () => {
      called = true;
      return [
        { id: "t1", name: "Alpha", slug: "alpha", orgId: "o1", orgName: "Org One" },
        { id: "t2", name: "Beta", slug: "beta", orgId: "o2", orgName: "Org Two" },
      ];
    },
  });
  const res = await app.request("/v1/teams?scope=all", {
    headers: { authorization: "Bearer x" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(called, true);
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].orgName, "Org One");
  assert.equal(body.nextCursor, null);
});

test("GET /v1/teams (no scope) keeps the active-org listing", async () => {
  let allCalled = false;
  const app = makeApp({
    listAllMyTeams: async () => {
      allCalled = true;
      return [];
    },
  });
  const res = await app.request("/v1/teams", {
    headers: { authorization: "Bearer x" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(allCalled, false);
  assert.equal(body.items[0].id, "active-only");
});

test("POST /v1/teams/:id/activate forwards bearer and returns refreshToken", async () => {
  let seenTeamId: string | undefined;
  let seenToken: string | undefined;
  const app = makeApp({
    switchActiveTeam: async (id: string, ctx: any) => {
      seenTeamId = id;
      seenToken = ctx?.accessToken;
      return { actorId: "a1", teamId: id, refreshToken: "rt-123" };
    },
  });
  const res = await app.request("/v1/teams/t9/activate", {
    method: "POST",
    headers: { authorization: "Bearer tok" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(seenTeamId, "t9");
  assert.equal(seenToken, "tok");
  assert.equal(body.refreshToken, "rt-123");
  assert.equal(body.teamId, "t9");
  assert.equal(body.actorId, "a1");
});
