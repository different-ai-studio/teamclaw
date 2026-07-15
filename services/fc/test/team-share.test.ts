import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { ApiError } from "../src/lib/http-utils.js";

function makeRepo(overrides: any = {}) {
  const calls = [];
  const repo = {
    calls,
    async enableShareMode(teamId, mode, gitConfig) {
      calls.push({ method: "enableShareMode", teamId, mode, gitConfig });
      if (overrides.enableShareModeError) throw overrides.enableShareModeError;
      return overrides.enableShareModeResult ?? {
        id: teamId,
        name: "Team",
        slug: null,
        createdAt: null,
        shareMode: mode,
        shareEnabledAt: "2026-05-28T00:00:00Z",
        gitRemoteUrl: gitConfig?.remoteUrl ?? null,
        gitAuthKind: gitConfig?.authKind ?? null,
      };
    },
    async getShareMode(teamId) {
      calls.push({ method: "getShareMode", teamId });
      if (overrides.getShareModeError) throw overrides.getShareModeError;
      return overrides.getShareModeResult ?? {
        mode: "oss",
        enabledAt: "2026-05-28T00:00:00Z",
        gitRemoteUrl: null,
        gitAuthKind: null,
      };
    },
    async disableShareMode(teamId) {
      calls.push({ method: "disableShareMode", teamId });
      if (overrides.disableShareModeError) throw overrides.disableShareModeError;
      return overrides.disableShareModeResult ?? {
        mode: null,
        enabledAt: null,
        gitRemoteUrl: null,
        gitAuthKind: null,
      };
    },
    async getWorkspaceConfig(teamId) {
      calls.push({ method: "getWorkspaceConfig", teamId });
      if (overrides.getWorkspaceConfigError) throw overrides.getWorkspaceConfigError;
      return overrides.getWorkspaceConfigResult ?? {
        shareMode: "custom_git",
        gitRemoteUrl: "git@example.com:org/repo.git",
        gitAuthKind: "ssh_key",
        syncMode: "oss",
        litellmTeamId: "lt-1",
        llm: {
          enabled: true,
          baseUrl: "https://proxy.example.com/v1",
          models: [{ id: "gpt-4o", name: "GPT-4o" }],
          availableModels: [{ id: "gpt-4o", name: "GPT-4o" }, { id: "o3", name: "o3" }],
          aiGatewayEndpoint: "https://ai.example.com/v1",
        },
      };
    },
    async setLlmConfig(teamId, input) {
      calls.push({ method: "setLlmConfig", teamId, input });
      if (overrides.setLlmConfigError) throw overrides.setLlmConfigError;
      return overrides.setLlmConfigResult ?? {
        enabled: input.enabled,
        baseUrl: input.baseUrl,
        models: input.models,
      };
    },
    async setupLiteLlm(teamId) {
      calls.push({ method: "setupLiteLlm", teamId });
      if (overrides.setupLiteLlmError) throw overrides.setupLiteLlmError;
      return overrides.setupLiteLlmResult ?? {
        aiGatewayEndpoint: "https://gw.example.com",
        litellmKey: "sk-test",
      };
    },
  };
  return repo;
}

function bearerHeaders() {
  return { Authorization: "Bearer test-token", "X-Request-Id": "req_share_test1" };
}

test("POST /v1/teams/:id/share-mode oss → 200 with team payload", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/share-mode",
    headers: bearerHeaders(),
    body: JSON.stringify({ mode: "oss" }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.shareMode, "oss");
  assert.deepEqual(repo.calls[0], {
    method: "enableShareMode",
    teamId: "team-1",
    mode: "oss",
    gitConfig: null,
  });
});

test("POST /v1/teams/:id/share-mode custom_git missing remoteUrl → 400", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/share-mode",
    headers: bearerHeaders(),
    body: JSON.stringify({ mode: "custom_git", gitConfig: { authKind: "ssh_key", credentialRef: "ref-1" } }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, "validation_failed");
  assert.equal(repo.calls.length, 0);
});

test("POST /v1/teams/:id/share-mode custom_git missing authKind → 400", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/share-mode",
    headers: bearerHeaders(),
    body: JSON.stringify({
      mode: "custom_git",
      gitConfig: { remoteUrl: "git@x.com:o/r.git", credentialRef: "r1" },
    }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 400);
  assert.equal(repo.calls.length, 0);
});

test("POST /v1/teams/:id/share-mode invalid mode → 400", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/share-mode",
    headers: bearerHeaders(),
    body: JSON.stringify({ mode: "bogus" }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, "validation_failed");
});

test("POST /v1/teams/:id/share-mode lock violation (pg check_violation) → 409", async () => {
  const lockErr = Object.assign(new Error("locked"), { code: "check_violation" });
  const repo = makeRepo({ enableShareModeError: lockErr });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/share-mode",
    headers: bearerHeaders(),
    body: JSON.stringify({ mode: "oss" }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, "share_mode_locked");
});

test("DELETE /v1/teams/:id/share-mode forbidden when not owner → 403", async () => {
  const repo = makeRepo({
    disableShareModeError: new ApiError(403, "forbidden", "only team owners may change team share mode"),
  });
  const res = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/teams/team-1/share-mode",
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, "forbidden");
});

test("DELETE /v1/teams/:id/share-mode → 200 and clears mode", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/teams/team-1/share-mode",
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.mode, null);
  assert.deepEqual(repo.calls[0], { method: "disableShareMode", teamId: "team-1" });
});

test("GET /v1/teams/:id/share-mode → 200", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/share-mode",
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    mode: "oss",
    enabledAt: "2026-05-28T00:00:00Z",
    gitRemoteUrl: null,
    gitAuthKind: null,
  });
});

test("GET /v1/teams/:id/workspace-config → 200 with merged shape", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/workspace-config",
    headers: bearerHeaders(),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    shareMode: "custom_git",
    gitRemoteUrl: "git@example.com:org/repo.git",
    gitAuthKind: "ssh_key",
    syncMode: "oss",
    litellmTeamId: "lt-1",
    llm: {
      enabled: true,
      baseUrl: "https://proxy.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
      availableModels: [{ id: "gpt-4o", name: "GPT-4o" }, { id: "o3", name: "o3" }],
      aiGatewayEndpoint: "https://ai.example.com/v1",
    },
  });
});

test("PUT /v1/teams/:id/llm-config → 200 persists config", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/llm-config",
    headers: bearerHeaders(),
    body: JSON.stringify({
      enabled: true,
      baseUrl: "https://proxy.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    enabled: true,
    baseUrl: "https://proxy.example.com/v1",
    models: [{ id: "gpt-4o", name: "GPT-4o" }],
  });
  assert.deepEqual(repo.calls[0], {
    method: "setLlmConfig",
    teamId: "team-1",
    input: { enabled: true, baseUrl: "https://proxy.example.com/v1", models: [{ id: "gpt-4o", name: "GPT-4o" }] },
  });
});

test("PUT /v1/teams/:id/llm-config null baseUrl + empty models → 200", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/llm-config",
    headers: bearerHeaders(),
    body: JSON.stringify({ enabled: false, baseUrl: null, models: [] }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.enabled, false);
  assert.equal(body.baseUrl, null);
  assert.deepEqual(body.models, []);
});

test("PUT /v1/teams/:id/llm-config non-boolean enabled → 400", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/llm-config",
    headers: bearerHeaders(),
    body: JSON.stringify({ enabled: "yes", baseUrl: null, models: [] }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0);
});

test("PUT /v1/teams/:id/llm-config models not array → 400", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/llm-config",
    headers: bearerHeaders(),
    body: JSON.stringify({ enabled: true, baseUrl: null, models: "gpt" }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0);
});

test("PUT /v1/teams/:id/llm-config malformed model entry → 400", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/llm-config",
    headers: bearerHeaders(),
    body: JSON.stringify({ enabled: true, baseUrl: null, models: [{ id: "gpt-4o" }] }),
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0);
});
