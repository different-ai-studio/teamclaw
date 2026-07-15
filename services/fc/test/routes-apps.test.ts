import { test } from "node:test";
import assert from "node:assert/strict";
import { registerApps } from "../src/lib/routes/apps.js";

function makeRouter() {
  const routes = [];
  const router = {
    get: (p, h) => routes.push(["GET", p, h]),
    post: (p, h) => routes.push(["POST", p, h]),
    patch: (p, h) => routes.push(["PATCH", p, h]),
  };
  return { router, routes };
}

test("POST /v1/apps creates and returns 201", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const post = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps")[2];
  const created = { id: "app-1", name: "X" };
  const res = await post({ json: { teamId: "t1", name: "X", type: "fullstack_tanstack_postgres" }, repository: { createApp: async () => created } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, created);
});

test("GET /v1/apps requires teamId", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const get = routes.find((r) => r[0] === "GET" && r[1] === "/v1/apps")[2];
  await assert.rejects(() => get({ query: new URLSearchParams(""), repository: {} }));
});

test("GET /v1/teams/:teamId/managed-git-credential returns creds", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/teams/:teamId/managed-git-credential")[2];
  const res = await handler({
    params: { teamId: "t1" },
    repository: { getManagedGitCredential: async () => ({ username: "teamclaw", token: "pt" }) },
  });
  assert.deepEqual(res.body, { username: "teamclaw", token: "pt" });
});

test("GET managed-git-credential 404s for non-member (repo returns null)", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "GET" && r[1] === "/v1/teams/:teamId/managed-git-credential")[2];
  await assert.rejects(() => handler({ params: { teamId: "t1" }, repository: { getManagedGitCredential: async () => null } }));
});

test("POST /v1/apps/:id/deploy returns 202 with deploy result", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps/:appId/deploy")[2];
  const result = { id: "app-1", fcStatus: "awaiting_build", ossObjectName: "apps/app-1/code.zip" };
  const res = await handler({ params: { appId: "app-1" }, repository: { deployApp: async () => result } });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, result);
});

test("POST /v1/apps/:id/deploy 404s when repo returns null", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps/:appId/deploy")[2];
  await assert.rejects(() => handler({ params: { appId: "x" }, repository: { deployApp: async () => null } }));
});

test("POST /v1/apps/:id/deploy/finalize returns 200 with the app", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps/:appId/deploy/finalize")[2];
  const result = { id: "app-1", fcStatus: "live", fcEndpoint: "https://x.fcapp.run" };
  const res = await handler({ params: { appId: "app-1" }, repository: { finalizeDeploy: async () => result } });
  assert.deepEqual(res.body, result);
});

test("POST /v1/apps/:id/deploy/finalize 404s when repo returns null", async () => {
  const { router, routes } = makeRouter();
  registerApps(router);
  const handler = routes.find((r) => r[0] === "POST" && r[1] === "/v1/apps/:appId/deploy/finalize")[2];
  await assert.rejects(() => handler({ params: { appId: "x" }, repository: { finalizeDeploy: async () => null } }));
});
