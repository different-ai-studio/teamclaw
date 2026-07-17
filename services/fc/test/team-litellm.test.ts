import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { ApiError } from "../src/lib/http-utils.js";

function bearerHeaders() {
  return { Authorization: "Bearer test-token", "X-Request-Id": "req_litellm_test" };
}

function makeRepo({ result, error, usage, usageError, memberKeyResult, memberKeyError, keysResult, keysError, budgetResult, budgetError }: any = {}) {
  const calls = [];
  return {
    calls,
    async setLiteLlmBudget(teamId, input) {
      calls.push({ method: "setLiteLlmBudget", teamId, input });
      if (budgetError) throw budgetError;
      return budgetResult ?? { maxBudget: Number(input?.maxBudget) };
    },
    async setupLiteLlm(teamId) {
      calls.push({ method: "setupLiteLlm", teamId });
      if (error) throw error;
      return result ?? { aiGatewayEndpoint: "https://gw.example.com", litellmKey: "sk-test" };
    },
    async ensureMemberKey(teamId) {
      calls.push({ method: "ensureMemberKey", teamId });
      if (memberKeyError) throw memberKeyError;
      return memberKeyResult ?? { key: "sk-tc-member", aiGatewayEndpoint: "https://gw.example.com" };
    },
    async listLiteLlmKeys(teamId) {
      calls.push({ method: "listLiteLlmKeys", teamId });
      if (keysError) throw keysError;
      return keysResult ?? {
        teamId: "litellm-generated-abc",
        keys: [{ key: "sk-abcdefghij...", alias: "member-1", spend: 1.5, created_at: "2026-06-01T00:00:00Z" }],
      };
    },
    async getLiteLlmUsage(teamId, opts) {
      calls.push({ method: "getLiteLlmUsage", teamId, opts });
      if (usageError) throw usageError;
      return usage ?? {
        litellmTeamId: `tc-${teamId}`,
        range: opts?.range ?? "month",
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        summary: { totalTokens: 100, promptTokens: 60, completionTokens: 40, totalSpend: 1.5, requestCount: 3 },
        maxBudget: 10,
        members: [{ actorId: "11111111-1111-4111-8111-111111111111", displayName: "周金亮", tokens: 100, spend: 1.5, requests: 3 }],
        byModel: [{ model: "kimi-k2.6", tokens: 100, spend: 1.5, requests: 3 }],
      };
    },
  };
}

test("POST /v1/teams/:id/litellm/setup → 200 returns gateway + key", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/litellm/setup",
    headers: bearerHeaders(),
    body: "{}",
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    aiGatewayEndpoint: "https://gw.example.com",
    litellmKey: "sk-test",
  });
  assert.deepEqual(repo.calls[0], { method: "setupLiteLlm", teamId: "team-1" });
});

test("POST /v1/teams/:id/litellm/setup repo throws ApiError 503 → 503 surfaced", async () => {
  const err = new ApiError(503, "litellm_unavailable", "LiteLLM provisioning is not configured");
  const repo = makeRepo({ error: err });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/litellm/setup",
    headers: bearerHeaders(),
    body: "{}",
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, "litellm_unavailable");
});

test("POST /v1/teams/:id/litellm/member-key → 200 returns key + gateway from repository", async () => {
  const repo = makeRepo({ memberKeyResult: { key: "sk-tc-team-1-member", aiGatewayEndpoint: "https://gw.example.com" } });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/litellm/member-key",
    headers: bearerHeaders(),
    body: "{}",
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    key: "sk-tc-team-1-member",
    aiGatewayEndpoint: "https://gw.example.com",
  });
  assert.deepEqual(repo.calls[0], { method: "ensureMemberKey", teamId: "team-1" });
});

test("POST /v1/teams/:id/litellm/member-key repo throws ApiError 503 → 503 surfaced", async () => {
  const err = new ApiError(503, "litellm_unavailable", "LiteLLM provisioning is not configured");
  const repo = makeRepo({ memberKeyError: err });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/litellm/member-key",
    headers: bearerHeaders(),
    body: "{}",
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, "litellm_unavailable");
});

test("GET /v1/teams/:id/litellm/usage → 200 returns team usage + passes range/date", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/litellm/usage",
    queryStringParameters: { range: "week", date: "2026-06-10" },
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.summary.totalTokens, 100);
  assert.equal(body.members[0].displayName, "周金亮");
  assert.equal(body.byModel[0].model, "kimi-k2.6");
  assert.deepEqual(repo.calls[0], {
    method: "getLiteLlmUsage",
    teamId: "team-1",
    opts: { range: "week", date: "2026-06-10" },
  });
});

test("GET /v1/teams/:id/litellm/usage defaults range to month when omitted", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/litellm/usage",
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  assert.equal(repo.calls[0].opts.range, "month");
  assert.equal(repo.calls[0].opts.date, undefined);
});

test("GET /v1/teams/:id/litellm/usage repo throws 503 → surfaced", async () => {
  const repo = makeRepo({ usageError: new ApiError(503, "litellm_usage_unavailable", "not configured") });
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/litellm/usage",
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error.code, "litellm_usage_unavailable");
});

test("GET /v1/teams/:id/litellm/keys → 200 returns mapped keys from persisted litellm team id", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/litellm/keys",
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    teamId: "litellm-generated-abc",
    keys: [{ key: "sk-abcdefghij...", alias: "member-1", spend: 1.5, created_at: "2026-06-01T00:00:00Z" }],
  });
  assert.deepEqual(repo.calls[0], { method: "listLiteLlmKeys", teamId: "team-1" });
});

test("GET /v1/teams/:id/litellm/keys → null litellm team id returns empty keys, no LiteLLM call", async () => {
  const repo = makeRepo({ keysResult: { teamId: null, keys: [] } });
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/litellm/keys",
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { teamId: null, keys: [] });
});

test("GET /v1/teams/:id/litellm/keys repo throws ApiError 403 for non-member → 403 surfaced", async () => {
  const repo = makeRepo({ keysError: new ApiError(403, "forbidden", "not a member of this team") });
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/litellm/keys",
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error.code, "forbidden");
});

test("PUT /v1/teams/:id/litellm/budget → 200 returns maxBudget and forwards it to repository", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/litellm/budget",
    headers: bearerHeaders(),
    body: JSON.stringify({ maxBudget: 25 }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, { maxBudget: 25 });
  assert.deepEqual(repo.calls[0], { method: "setLiteLlmBudget", teamId: "team-1", input: { maxBudget: 25 } });
});

test("PUT /v1/teams/:id/litellm/budget repo throws ApiError 403 for non-owner → 403 surfaced", async () => {
  const repo = makeRepo({ budgetError: new ApiError(403, "forbidden", "only team owners may change team share mode") });
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/litellm/budget",
    headers: bearerHeaders(),
    body: JSON.stringify({ maxBudget: 25 }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error.code, "forbidden");
});

test("PUT /v1/teams/:id/litellm/budget repo throws ApiError 409 when unprovisioned → 409 surfaced", async () => {
  const repo = makeRepo({ budgetError: new ApiError(409, "litellm_not_provisioned", "team has not provisioned LiteLLM") });
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/litellm/budget",
    headers: bearerHeaders(),
    body: JSON.stringify({ maxBudget: 25 }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error.code, "litellm_not_provisioned");
});

test("PUT /v1/teams/:id/litellm/budget repo throws ApiError 400 for missing maxBudget → 400 surfaced", async () => {
  const repo = makeRepo({ budgetError: new ApiError(400, "missing_maxBudget", "maxBudget is required") });
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/litellm/budget",
    headers: bearerHeaders(),
    body: JSON.stringify({}),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, "missing_maxBudget");
});
