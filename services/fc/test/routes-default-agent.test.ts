import { test } from "node:test";
import assert from "node:assert/strict";
import { registerActors } from "../src/lib/routes/actors.js";
import { ApiError } from "../src/lib/http-utils.js";

function makeRouter() {
  const routes: Array<[string, string, Function]> = [];
  const router = {
    get: (p, h) => routes.push(["GET", p, h]),
    put: (p, h) => routes.push(["PUT", p, h]),
    post: (p, h) => routes.push(["POST", p, h]),
    patch: (p, h) => routes.push(["PATCH", p, h]),
    delete: (p, h) => routes.push(["DELETE", p, h]),
  };
  return { router, routes };
}

function findRoute(routes: Array<[string, string, Function]>, method: string, path: string) {
  const found = routes.find((r) => r[0] === method && r[1] === path);
  if (!found) throw new Error(`Route ${method} ${path} not registered`);
  return found[2];
}

// --- GET /v1/teams/:teamId/default-agent ---

test("GET /v1/teams/:teamId/default-agent returns { defaultAgentId } from repository", async () => {
  const { router, routes } = makeRouter();
  registerActors(router);
  const handler = findRoute(routes, "GET", "/v1/teams/:teamId/default-agent");
  const res = await handler({
    params: { teamId: "team-1" },
    repository: { getTeamDefaultAgent: async (teamId) => {
      assert.equal(teamId, "team-1");
      return { defaultAgentId: "agent-abc" };
    }},
  });
  assert.deepEqual(res.body, { defaultAgentId: "agent-abc" });
});

test("GET /v1/teams/:teamId/default-agent returns null when unset", async () => {
  const { router, routes } = makeRouter();
  registerActors(router);
  const handler = findRoute(routes, "GET", "/v1/teams/:teamId/default-agent");
  const res = await handler({
    params: { teamId: "team-1" },
    repository: { getTeamDefaultAgent: async () => ({ defaultAgentId: null }) },
  });
  assert.deepEqual(res.body, { defaultAgentId: null });
});

test("GET /v1/teams/:teamId/default-agent decodes URI-encoded teamId", async () => {
  const { router, routes } = makeRouter();
  registerActors(router);
  const handler = findRoute(routes, "GET", "/v1/teams/:teamId/default-agent");
  let received: string | undefined;
  await handler({
    params: { teamId: "team%2F1" },
    repository: { getTeamDefaultAgent: async (id) => { received = id; return { defaultAgentId: null }; }},
  });
  assert.equal(received, "team/1");
});

// --- PUT /v1/teams/:teamId/default-agent ---

test("PUT /v1/teams/:teamId/default-agent forwards agentId to setTeamDefaultAgent", async () => {
  const { router, routes } = makeRouter();
  registerActors(router);
  const handler = findRoute(routes, "PUT", "/v1/teams/:teamId/default-agent");
  let receivedTeamId: string | undefined;
  let receivedAgentId: string | null | undefined;
  const res = await handler({
    params: { teamId: "team-1" },
    json: { agentId: "agent-xyz" },
    repository: {
      setTeamDefaultAgent: async (teamId, agentId) => {
        receivedTeamId = teamId;
        receivedAgentId = agentId;
        return { defaultAgentId: "agent-xyz" };
      },
    },
  });
  assert.equal(receivedTeamId, "team-1");
  assert.equal(receivedAgentId, "agent-xyz");
  assert.deepEqual(res.body, { defaultAgentId: "agent-xyz" });
});

test("PUT /v1/teams/:teamId/default-agent forwards null when agentId is null", async () => {
  const { router, routes } = makeRouter();
  registerActors(router);
  const handler = findRoute(routes, "PUT", "/v1/teams/:teamId/default-agent");
  let receivedAgentId: string | null | undefined;
  await handler({
    params: { teamId: "team-1" },
    json: { agentId: null },
    repository: {
      setTeamDefaultAgent: async (_teamId, agentId) => {
        receivedAgentId = agentId;
        return { defaultAgentId: null };
      },
    },
  });
  assert.equal(receivedAgentId, null);
});

test("PUT /v1/teams/:teamId/default-agent forwards null when agentId is missing", async () => {
  const { router, routes } = makeRouter();
  registerActors(router);
  const handler = findRoute(routes, "PUT", "/v1/teams/:teamId/default-agent");
  let receivedAgentId: string | null | undefined = "sentinel";
  await handler({
    params: { teamId: "team-1" },
    json: {},
    repository: {
      setTeamDefaultAgent: async (_teamId, agentId) => {
        receivedAgentId = agentId;
        return { defaultAgentId: null };
      },
    },
  });
  assert.equal(receivedAgentId, null);
});

test("PUT /v1/teams/:teamId/default-agent propagates 403 from repository", async () => {
  const { router, routes } = makeRouter();
  registerActors(router);
  const handler = findRoute(routes, "PUT", "/v1/teams/:teamId/default-agent");
  await assert.rejects(
    () =>
      handler({
        params: { teamId: "team-1" },
        json: { agentId: "agent-xyz" },
        repository: {
          setTeamDefaultAgent: async () => {
            throw new ApiError(403, "forbidden", "only admins can set team default agent");
          },
        },
      }),
    (err: any) => {
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

// --- GET /v1/teams/:teamId/members/me/effective-default-agent ---

test("GET effective-default-agent returns member default when set", async () => {
  const { router, routes } = makeRouter();
  registerActors(router);
  const handler = findRoute(routes, "GET", "/v1/teams/:teamId/members/me/effective-default-agent");
  const res = await handler({
    params: { teamId: "team-1" },
    repository: { getEffectiveDefaultAgent: async (teamId) => {
      assert.equal(teamId, "team-1");
      return { defaultAgentId: "my-agent" };
    }},
  });
  assert.deepEqual(res.body, { defaultAgentId: "my-agent" });
});

test("GET effective-default-agent returns team fallback (null member, non-null team)", async () => {
  const { router, routes } = makeRouter();
  registerActors(router);
  const handler = findRoute(routes, "GET", "/v1/teams/:teamId/members/me/effective-default-agent");
  const res = await handler({
    params: { teamId: "team-1" },
    repository: { getEffectiveDefaultAgent: async () => ({ defaultAgentId: "team-agent" }) },
  });
  assert.deepEqual(res.body, { defaultAgentId: "team-agent" });
});

test("GET effective-default-agent returns null when neither member nor team has default", async () => {
  const { router, routes } = makeRouter();
  registerActors(router);
  const handler = findRoute(routes, "GET", "/v1/teams/:teamId/members/me/effective-default-agent");
  const res = await handler({
    params: { teamId: "team-1" },
    repository: { getEffectiveDefaultAgent: async () => ({ defaultAgentId: null }) },
  });
  assert.deepEqual(res.body, { defaultAgentId: null });
});
