import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

function deps() {
  return {
    createRepository: ({ accessToken }: { accessToken: string }) => ({
      listTeams: async () => [{ id: "t1", name: "Team", accessToken }],
    }),
    createAuthRepository: () => ({}),
  };
}

test("GET /v1/teams routes through adapter with bearer", async () => {
  const app = createApp(deps() as any);
  const res = await app.request("/v1/teams", { headers: { authorization: "Bearer abc" } });
  assert.notEqual(res.status, 404);
  assert.notEqual(res.status, 401);
});

test("unknown route -> 404 not_found envelope", async () => {
  const app = createApp(deps() as any);
  const res = await app.request("/v1/nope-nope", { headers: { authorization: "Bearer abc" } });
  assert.equal(res.status, 404);
  assert.equal((await res.json() as any).error.code, "not_found");
});

test("missing bearer on /v1/teams -> 401", async () => {
  const app = createApp(deps() as any);
  const res = await app.request("/v1/teams");
  assert.equal(res.status, 401);
});
