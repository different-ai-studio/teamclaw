import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

// GET /v1/teams?scope=all is a bearer route, so it resolves the BUSINESS
// repository (createRepository). POST /v1/teams/:id/activate is registered with
// { auth: "none" }, so it resolves the AUTH repository (createAuthRepository) —
// which owns switchActiveTeam (it forwards the bearer itself).
function makeApp({
  listAllMyTeams,
  listDiscoverableTeams,
  bootstrapTeam,
  switchActiveTeam,
}: {
  listAllMyTeams?: (...args: any[]) => any;
  listDiscoverableTeams?: (...args: any[]) => any;
  bootstrapTeam?: (...args: any[]) => any;
  switchActiveTeam?: (...args: any[]) => any;
}) {
  return createApp({
    createRepository: ({ accessToken }: { accessToken: string }) => ({
      listTeams: async () => [{ id: "active-only", name: "Active", accessToken }],
      listAllMyTeams,
      listDiscoverableTeams,
      bootstrapTeam,
    }),
    createAuthRepository: () => ({
      switchActiveTeam,
    }),
  } as any);
}

test("GET /v1/teams?scope=all forwards empty-org picker opt-in and returns orgName", async () => {
  let received: any;
  const app = makeApp({
    listAllMyTeams: async (args: any) => {
      received = args;
      return [
        { id: "t1", name: "Alpha", slug: "alpha", orgId: "o1", orgName: "Org One" },
        { id: "t2", name: "Beta", slug: "beta", orgId: "o2", orgName: "Org Two" },
      ];
    },
  });
  const res = await app.request("/v1/teams?scope=all&includeEmptyOrgs=true", {
    headers: { authorization: "Bearer x" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.deepEqual(received, { includeEmptyOrgs: true });
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].orgName, "Org One");
  assert.equal(body.nextCursor, null);
});

test("GET /v1/teams?scope=discoverable returns public browsing rows", async () => {
  const app = makeApp({
    listDiscoverableTeams: async () => [
      { id: "public-1", name: "Open Team", slug: "open", orgId: "o1", orgName: "Org One", visibility: "public", isMember: false },
    ],
  });
  const res = await app.request("/v1/teams?scope=discoverable", {
    headers: { authorization: "Bearer anonymous-token" },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.deepEqual(body.items[0], {
    id: "public-1", name: "Open Team", slug: "open", orgId: "o1", orgName: "Org One", visibility: "public", isMember: false,
  });
});

test("POST /v1/teams/bootstrap delegates atomic first-team creation", async () => {
  let input: any;
  const app = makeApp({
    bootstrapTeam: async (received: any) => {
      input = received;
      return { id: "org-team", name: "Org One", slug: "org-one" };
    },
  });
  const res = await app.request("/v1/teams/bootstrap", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Boss" }),
  });
  assert.equal(res.status, 200);
  // deviceId rides along for guest-team reuse; a signed-in bootstrap sends none.
  assert.deepEqual(input, { displayName: "Boss", orgId: null, deviceId: null });
  assert.equal((await res.json() as any).name, "Org One");
});

test("POST /v1/teams/bootstrap forwards an explicitly selected empty org", async () => {
  let input: any;
  const app = makeApp({
    bootstrapTeam: async (received: any) => {
      input = received;
      return { id: "org-team", name: "Org One", slug: "org-one" };
    },
  });
  const res = await app.request("/v1/teams/bootstrap", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ orgId: "00000000-0000-4000-8000-000000000001" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(input, {
    displayName: null,
    orgId: "00000000-0000-4000-8000-000000000001",
    deviceId: null,
  });
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
