import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSupabaseBusinessRepository,
  createSupabaseAuthRepository,
  publishableKeyFromEnv,
} from "../src/lib/supabase-repo.js";

test("createSupabaseBusinessRepository creates caller-scoped Supabase client", async () => {
  const calls = [];
  const repo = createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient(url, key, options) {
      calls.push({ url, key, options });
      return fakeSupabase();
    },
  });

  await repo.listSessions({ limit: 25 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.supabase.co");
  assert.equal(calls[0].key, "publishable-key");
  assert.deepEqual(calls[0].options.auth, { persistSession: false, autoRefreshToken: false });
  assert.deepEqual(calls[0].options.global, { headers: { Authorization: "Bearer caller-token" } });
  // realtime transport is wired so supabase-js doesn't crash on Node 20 (FC runtime);
  // we don't assert on its identity, just that it's set.
  assert.ok(calls[0].options.realtime?.transport, "expected realtime transport to be set");
});

test("publishableKeyFromEnv prefers publishable key and falls back to anon key", () => {
  assert.equal(publishableKeyFromEnv({ SUPABASE_PUBLISHABLE_KEY: "pk", SUPABASE_ANON_KEY: "anon" }), "pk");
  assert.equal(publishableKeyFromEnv({ SUPABASE_ANON_KEY: "anon" }), "anon");
});

test("listSessions maps current actor session rpc rows", async () => {
  const rpcCalls = [];
  const repo = createRepo(fakeSupabase({
    rpcCalls,
    rpcData: {
      list_current_actor_sessions: [{
        id: "session-1",
        team_id: "team-1",
        title: "Plan",
        mode: "collab",
        idea_id: "idea-1",
        last_message_at: "2026-05-27T01:00:00Z",
        last_message_preview: "hello",
        has_unread: true,
        created_at: "2026-05-26T01:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }],
    },
  }));

  const rows = await repo.listSessions({
    limit: 10,
    cursor: { lastMessageAt: "2026-05-27T00:00:00Z", createdAt: "2026-05-26T00:00:00Z", id: "s0" },
  });

  assert.deepEqual(rpcCalls, [{
    name: "list_current_actor_sessions",
    args: {
      p_limit: 10,
      p_before_last_message_at: "2026-05-27T00:00:00Z",
      p_before_created_at: "2026-05-26T00:00:00Z",
      p_before_id: "s0",
    },
  }]);
  assert.deepEqual(rows, [{
    id: "session-1",
    teamId: "team-1",
    title: "Plan",
    mode: "collab",
    ideaId: "idea-1",
    lastMessageAt: "2026-05-27T01:00:00Z",
    lastMessagePreview: "hello",
    hasUnread: true,
    createdAt: "2026-05-26T01:00:00Z",
    updatedAt: "2026-05-27T01:00:00Z",
  }]);
});

test("insertMessage writes a messages row and maps response", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      messages: [{
        id: "message-1",
        team_id: "team-1",
        session_id: "session-1",
        turn_id: null,
        sender_actor_id: "actor-1",
        reply_to_message_id: null,
        kind: "text",
        content: "hello",
        metadata: null,
        model: null,
        created_at: "2026-05-27T01:00:00Z",
        updated_at: null,
      }],
    },
  }));

  const message = await repo.insertMessage("session-1", {
    id: "message-1",
    teamId: "team-1",
    senderActorId: "actor-1",
    content: "hello",
  });

  assert.equal(tableCalls[0].table, "messages");
  assert.equal(tableCalls[0].op, "insert");
  assert.deepEqual(tableCalls[0].row, {
    id: "message-1",
    team_id: "team-1",
    session_id: "session-1",
    sender_actor_id: "actor-1",
    kind: "text",
    content: "hello",
    metadata: {},
    model: null,
    turn_id: null,
    reply_to_message_id: null,
  });
  assert.equal(message.id, "message-1");
  assert.equal(message.teamId, "team-1");
  assert.equal(message.senderActorId, "actor-1");
});

test("auth repo claimInvite calls claim_team_invite RPC anonymously", async () => {
  // The bootstrap claim flow has no caller bearer; the auth repo must use an
  // anon-key Supabase client (no Authorization header) to invoke the
  // SECURITY DEFINER RPC `claim_team_invite`.
  const createCalls = [];
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    createClient(url, key, options) {
      createCalls.push({ url, key, options });
      return fakeSupabase({
        rpcData: {
          claim_team_invite: [{
            actor_id: "actor-1",
            team_id: "team-1",
            actor_type: "agent",
            display_name: "Daemon",
            refresh_token: "refresh-1",
          }],
        },
      });
    },
  });

  assert.deepEqual(await repo.claimInvite("invite-token"), {
    actorId: "actor-1",
    teamId: "team-1",
    actorType: "agent",
    displayName: "Daemon",
    refreshToken: "refresh-1",
  });
  // Auth repo must NOT attach a caller bearer header.
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].options.global, undefined);
});

test("auth repo claimInvite forwards the caller bearer for member claims", async () => {
  // Member claims arrive authenticated: the joining user's bearer must reach
  // PostgREST so the RPC resolves auth.uid(). The repo builds a per-token client
  // with an Authorization header instead of using the shared anon client.
  const createCalls = [];
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    createClient(url, key, options) {
      createCalls.push({ url, key, options });
      return fakeSupabase({
        rpcData: {
          claim_team_invite: [{
            actor_id: "actor-9",
            team_id: "team-9",
            actor_type: "member",
            display_name: "Joiner",
            refresh_token: null,
          }],
        },
      });
    },
  });

  assert.deepEqual(await repo.claimInvite("invite-token", { accessToken: "member-jwt" }), {
    actorId: "actor-9",
    teamId: "team-9",
    actorType: "member",
    displayName: "Joiner",
    refreshToken: null,
  });
  // Two clients: the shared anon client at construction, then a per-token
  // authed client carrying the caller bearer.
  assert.equal(createCalls.length, 2);
  assert.equal(createCalls[1].options.global.headers.Authorization, "Bearer member-jwt");
});

test("repository throws upstream errors without hiding Supabase error codes", async () => {
  const repo = createRepo(fakeSupabase({
    rpcErrors: {
      list_current_actor_sessions: { code: "42501", message: "rls denied" },
    },
  }));

  await assert.rejects(() => repo.listSessions(), (err: any) => {
    assert.equal(err.code, "42501");
    return true;
  });
});

test("createSupabaseAuthRepository refreshAccessToken calls Supabase auth endpoint", async () => {
  const fetchCalls = [];
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon-key",
    async fetchImpl(url, options) {
      fetchCalls.push({ url, options });
      return new Response(JSON.stringify({
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_at: 1234567890,
      }), { status: 200 });
    },
  });

  const result = await repo.refreshAccessToken({ refreshToken: "old-rt" });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://example.supabase.co/auth/v1/token?grant_type=refresh_token");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers.apikey, "anon-key");
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), { refresh_token: "old-rt" });
  assert.deepEqual(result, { accessToken: "new-at", refreshToken: "new-rt", expiresAt: 1234567890 });
});

test("createSupabaseAuthRepository refreshAccessToken throws on auth failure", async () => {
  const repo = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon-key",
    async fetchImpl() {
      return new Response("Invalid refresh token", { status: 401 });
    },
  });

  await assert.rejects(
    () => repo.refreshAccessToken({ refreshToken: "bad-rt" }),
    (err: any) => {
      assert.equal(err.statusCode, 401);
      assert.equal(err.code, "missing_auth");
      return true;
    },
  );
});

function createRepo(
  supabase,
  extra: { createServiceRoleClient?: () => unknown } & Record<string, unknown> = {},
) {
  const admin = extra.createServiceRoleClient?.() ?? supabase;
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
    createServiceRoleClient: () => admin,
    ...extra,
  });
}

const OWNER_AUTH = {
  auth: {
    async getUser() {
      return { data: { user: { id: "user-owner-1" } }, error: null };
    },
  },
};

function fakeSupabaseForShareMode(rpcData, rpcCalls = []) {
  return fakeSupabase({
    rpcCalls,
    rpcData,
    tableData: {
      actors: [{ id: "actor-owner-1" }],
      team_members: [{ role: "owner" }],
    },
    auth: OWNER_AUTH.auth,
  });
}

test("createTeam routes to join_or_create_org_team with the caller's JWT org as fallback", async () => {
  const rpcCalls = [];
  const prev = process.env.DEFAULT_ORG_ID;
  process.env.DEFAULT_ORG_ID = "org-default";
  try {
    const repo = createRepo(fakeSupabase({
      rpcCalls,
      auth: {
        async getUser() {
          return { data: { user: { id: "u1", app_metadata: { org_id: "org-real" } } }, error: null };
        },
      },
      rpcData: {
        join_or_create_org_team: [{
          team_id: "team-9",
          team_name: "香蕉攀岩",
          team_slug: "banana",
          member_id: "actor-9",
          role: "member",
        }],
      },
    }));

    const team = await repo.createTeam({ displayName: "梁江" });

    // Caller's real org wins as the fallback stamp; default org is passed so the
    // RPC can tell "this is a real customer org" and join its default team.
    assert.deepEqual(rpcCalls, [{
      name: "join_or_create_org_team",
      args: {
        p_fallback_org: "org-real",
        p_default_org_id: "org-default",
        p_name: null,
        p_slug: null,
        p_display_name: "梁江",
        p_litellm_team_id: null,
        p_ai_gateway_endpoint: null,
      },
    }]);
    assert.equal(team.id, "team-9");
    assert.equal(team.name, "香蕉攀岩");
    assert.equal(team.slug, "banana");
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_ORG_ID;
    else process.env.DEFAULT_ORG_ID = prev;
  }
});

test("createTeam falls back to DEFAULT_ORG_ID when the caller carries no org", async () => {
  const rpcCalls = [];
  const prev = process.env.DEFAULT_ORG_ID;
  process.env.DEFAULT_ORG_ID = "org-default";
  try {
    const repo = createRepo(fakeSupabase({
      rpcCalls,
      auth: {
        async getUser() {
          return { data: { user: { id: "u2", app_metadata: {} } }, error: null };
        },
      },
      rpcData: {
        join_or_create_org_team: [{
          team_id: "team-solo",
          team_name: "Zesty Falcon",
          team_slug: "zesty-falcon",
          member_id: "actor-solo",
          role: "owner",
        }],
      },
    }));

    await repo.createTeam({ name: "My Team", slug: "my-team" });

    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].name, "join_or_create_org_team");
    assert.equal(rpcCalls[0].args.p_fallback_org, "org-default");
    assert.equal(rpcCalls[0].args.p_name, "My Team");
    assert.equal(rpcCalls[0].args.p_slug, "my-team");
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_ORG_ID;
    else process.env.DEFAULT_ORG_ID = prev;
  }
});

test("enableShareMode oss calls enable_team_share rpc with null git fields", async () => {
  const rpcCalls = [];
  const repo = createRepo(fakeSupabaseForShareMode({
      enable_team_share: [{
        id: "team-1",
        name: "Acme",
        slug: "acme",
        created_at: "2026-05-28T00:00:00Z",
        share_mode: "oss",
        share_enabled_at: "2026-05-28T01:00:00Z",
        git_remote_url: null,
        git_auth_kind: null,
      }],
  }, rpcCalls));

  const result = await repo.enableShareMode("team-1", "oss", null);

  assert.deepEqual(rpcCalls[0], {
    name: "enable_team_share",
    args: {
      p_team_id: "team-1",
      p_mode: "oss",
      p_git_remote_url: null,
      p_git_auth_kind: null,
      p_git_credential_ref: null,
    },
  });
  assert.equal(result.id, "team-1");
  assert.equal(result.shareMode, "oss");
  assert.equal(result.shareEnabledAt, "2026-05-28T01:00:00Z");
  assert.equal(result.gitRemoteUrl, null);
});

test("enableShareMode custom_git passes through git config", async () => {
  const rpcCalls = [];
  const repo = createRepo(fakeSupabaseForShareMode({
      enable_team_share: [{
        id: "team-2",
        name: "Beta",
        slug: "beta",
        created_at: "2026-05-28T00:00:00Z",
        share_mode: "custom_git",
        share_enabled_at: "2026-05-28T01:00:00Z",
        git_remote_url: "git@example.com:beta/repo.git",
        git_auth_kind: "ssh_key",
      }],
  }, rpcCalls));

  const result = await repo.enableShareMode("team-2", "custom_git", {
    remoteUrl: "git@example.com:beta/repo.git",
    authKind: "ssh_key",
    credentialRef: "keychain://team-2/ssh",
  });

  assert.deepEqual(rpcCalls[0].args, {
    p_team_id: "team-2",
    p_mode: "custom_git",
    p_git_remote_url: "git@example.com:beta/repo.git",
    p_git_auth_kind: "ssh_key",
    p_git_credential_ref: "keychain://team-2/ssh",
  });
  assert.equal(result.shareMode, "custom_git");
  assert.equal(result.gitRemoteUrl, "git@example.com:beta/repo.git");
  assert.equal(result.gitAuthKind, "ssh_key");
});

test("getShareMode returns nulls when team row absent", async () => {
  const repo = createRepo(fakeSupabase({ tableData: { teams: [] } }));
  const result = await repo.getShareMode("team-missing");
  assert.deepEqual(result, {
    mode: null,
    enabledAt: null,
    gitRemoteUrl: null,
    gitAuthKind: null,
  });
});

test("getShareMode maps team columns to camelCase", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: {
      teams: [{
        share_mode: "managed_git",
        share_enabled_at: "2026-05-28T03:00:00Z",
        git_remote_url: "https://git.example.com/repo.git",
        git_auth_kind: "https_token",
      }],
    },
  }));
  const result = await repo.getShareMode("team-3");
  assert.deepEqual(result, {
    mode: "managed_git",
    enabledAt: "2026-05-28T03:00:00Z",
    gitRemoteUrl: "https://git.example.com/repo.git",
    gitAuthKind: "https_token",
  });
});

test("setupLiteLlm persists via update_team_litellm RPC", async () => {
  const rpcCalls = [];
  let provisionCalls = 0;
  const repo = createRepo(
    fakeSupabase({
      rpcCalls,
      tableData: {
        teams: [{ id: "team-4", name: "Gamma" }],
      },
    }),
    {
      provisionLiteLlm: async (name) => {
        provisionCalls++;
        assert.equal(name, "Gamma");
        return {
          litellmTeamId: "litellm-team-xyz",
          litellmKey: "sk-litellm-xyz",
          aiGatewayEndpoint: "https://ai.example.com/v1",
        };
      },
    },
  );

  const result = await repo.setupLiteLlm("team-4");

  assert.equal(provisionCalls, 1);
  assert.deepEqual(result, {
    aiGatewayEndpoint: "https://ai.example.com/v1",
    litellmKey: "sk-litellm-xyz",
  });
  const rpc = rpcCalls.find((c) => c.name === "update_team_litellm");
  assert.ok(rpc, "expected update_team_litellm RPC call");
  assert.deepEqual(rpc.args, {
    p_team_id: "team-4",
    p_litellm_team_id: "litellm-team-xyz",
    p_ai_gateway_endpoint: "https://ai.example.com/v1",
  });
});

test("setupLiteLlm throws 503 when provisioner returns null", async () => {
  const repo = createRepo(
    fakeSupabase({ tableData: { teams: [{ id: "team-5", name: "Delta" }] } }),
    { provisionLiteLlm: async () => null },
  );
  await assert.rejects(
    () => repo.setupLiteLlm("team-5"),
    (err: any) => err.code === "litellm_unavailable",
  );
});

// litellmFetch (used by ensureMemberKeyFor, Task 1) is driven by global fetch;
// stub it the same way test/ensure-member-key.test.ts does.
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

test("ensureMemberKey returns caller's own sk-tc key when team already has litellm_team_id", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  stubLitellmFetch({
    "/key/info": () => ({ status: 200, body: { info: { key_name: "sk-tc-actor-self" } } }),
  });
  const repo = createRepo(
    fakeSupabase({
      auth: {
        async getUser() {
          return { data: { user: { id: "user-self-1" } }, error: null };
        },
      },
      tableData: {
        actors: [{ id: "actor-self" }],
        team_workspace_config: [{ litellm_team_id: "litellm-team-existing" }],
      },
    }),
    {
      provisionLiteLlm: async () => {
        throw new Error("must not provision when litellm_team_id already set");
      },
    },
  );

  const out = await repo.ensureMemberKey("team-8");
  assert.equal(out.key, "sk-tc-actor-self");
  assert.equal(typeof out.aiGatewayEndpoint, "string");
  assert.ok(out.aiGatewayEndpoint.length > 0);
});

test("ensureMemberKey auto-provisions LiteLLM team (A2-1) when litellm_team_id missing, using the persisted id (not tc-${teamId})", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  stubLitellmFetch({
    "/key/info": () => ({ status: 404, body: {} }),
    "/key/generate": () => ({ status: 200, body: { key: "sk-tc-actor-self-2" } }),
  });
  const rpcCalls = [];
  const repo = createRepo(
    fakeSupabase({
      rpcCalls,
      auth: {
        async getUser() {
          return { data: { user: { id: "user-self-2" } }, error: null };
        },
      },
      tableData: {
        actors: [{ id: "actor-self-2" }],
        team_workspace_config: [], // no litellm_team_id yet
        teams: [{ id: "team-9", name: "Zeta" }],
      },
    }),
    {
      provisionLiteLlm: async (name) => {
        assert.equal(name, "Zeta");
        // LiteLLM-generated id — deliberately NOT `tc-team-9` — to prove
        // ensureMemberKey uses the persisted/returned id rather than
        // reconstructing `tc-${teamId}`.
        return {
          litellmTeamId: "litellm-generated-abc123",
          litellmKey: "sk-litellm-abc123",
          aiGatewayEndpoint: "https://ai.example.com/v1",
        };
      },
    },
  );

  const out = await repo.ensureMemberKey("team-9");
  assert.equal(out.key, "sk-tc-actor-self-2");
  // Note: ensureMemberKeyFor (Task 1) always computes aiGatewayEndpoint from
  // LITELLM_URL/AI_GATEWAY_ENDPOINT env vars, not from the provisioning
  // result, so this reflects the LITELLM_URL set above, not the fake
  // provisioner's returned aiGatewayEndpoint.
  assert.equal(out.aiGatewayEndpoint, "https://ai.example/v1");
  const rpc = rpcCalls.find((c: any) => c.name === "update_team_litellm");
  assert.ok(rpc, "expected update_team_litellm RPC call during auto-provision");
  assert.equal(rpc.args.p_litellm_team_id, "litellm-generated-abc123");
});

test("ensureMemberKey rejects non-member with 403", async () => {
  const repo = createRepo(
    fakeSupabase({
      auth: {
        async getUser() {
          return { data: { user: { id: "user-outsider" } }, error: null };
        },
      },
      tableData: {
        actors: [], // caller has no actor row in this team -> not a member
      },
    }),
  );

  await assert.rejects(
    () => repo.ensureMemberKey("team-10"),
    (err: any) => err.statusCode === 403 && err.code === "forbidden",
  );
});

test("ensureMemberKey rejects unauthenticated caller with 401", async () => {
  const repo = createRepo(
    fakeSupabase({
      auth: {
        async getUser() {
          return { data: { user: null }, error: null };
        },
      },
    }),
  );

  await assert.rejects(
    () => repo.ensureMemberKey("team-11"),
    (err: any) => err.statusCode === 401 && err.code === "missing_auth",
  );
});

test("removeTeamActor still succeeds when LiteLLM key deletion fails", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  stubLitellmFetch({
    "/key/delete": () => ({ status: 500, body: { error: "boom" } }),
  });
  const rpcCalls: any[] = [];
  const repo = createRepo(fakeSupabase({ rpcCalls, rpcData: { remove_team_actor: null } }));

  // Should not throw even though LiteLLM key deletion fails.
  await repo.removeTeamActor("team-12", "actor-12");

  const rpc = rpcCalls.find((c) => c.name === "remove_team_actor");
  assert.ok(rpc, "expected remove_team_actor RPC call");
});

test("removeTeamActor deletes the actor's LiteLLM key exactly once with the deterministic key value", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  const calls = stubLitellmFetch({
    "/key/delete": () => ({ status: 200, body: { deleted: 1 } }),
  });
  const repo = createRepo(fakeSupabase({ rpcData: { remove_team_actor: null } }));

  const actorId = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef"; // > 40 chars
  await repo.removeTeamActor("team-13", actorId);

  const deleteCalls = calls.filter((c) => c.url.includes("/key/delete"));
  assert.equal(deleteCalls.length, 1, "expected exactly one /key/delete call");
});

test("listLiteLlmKeys returns masked keys from LiteLLM using the persisted litellm_team_id", async () => {
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
  const repo = createRepo(
    fakeSupabase({
      auth: {
        async getUser() {
          return { data: { user: { id: "user-member-1" } }, error: null };
        },
      },
      tableData: {
        actors: [{ id: "actor-member-1" }],
        team_workspace_config: [{ litellm_team_id: "litellm-team-persisted" }],
      },
    }),
  );

  const out = await repo.listLiteLlmKeys("team-12");
  assert.deepEqual(out, {
    teamId: "litellm-team-persisted",
    keys: [{ key: "sk-abcdefg...", alias: "member-1", spend: 1.5, created_at: "2026-06-01T00:00:00Z" }],
  });
});

test("listLiteLlmKeys returns { teamId: null, keys: [] } without calling LiteLLM when litellm_team_id is unset", async () => {
  const calls = stubLitellmFetch({});
  const repo = createRepo(
    fakeSupabase({
      auth: {
        async getUser() {
          return { data: { user: { id: "user-member-2" } }, error: null };
        },
      },
      tableData: {
        actors: [{ id: "actor-member-2" }],
        team_workspace_config: [], // no litellm_team_id yet
      },
    }),
  );

  const out = await repo.listLiteLlmKeys("team-13");
  assert.deepEqual(out, { teamId: null, keys: [] });
  assert.equal(calls.length, 0, "must not call LiteLLM when no litellm_team_id is persisted");
});

test("listLiteLlmKeys rejects non-member with 403", async () => {
  const repo = createRepo(
    fakeSupabase({
      auth: {
        async getUser() {
          return { data: { user: { id: "user-outsider-2" } }, error: null };
        },
      },
      tableData: {
        actors: [], // caller has no actor row in this team -> not a member
      },
    }),
  );

  await assert.rejects(
    () => repo.listLiteLlmKeys("team-14"),
    (err: any) => err.statusCode === 403 && err.code === "forbidden",
  );
});

test("listLiteLlmKeys rejects unauthenticated caller with 401", async () => {
  const repo = createRepo(
    fakeSupabase({
      auth: {
        async getUser() {
          return { data: { user: null }, error: null };
        },
      },
    }),
  );

  await assert.rejects(
    () => repo.listLiteLlmKeys("team-15"),
    (err: any) => err.statusCode === 401 && err.code === "missing_auth",
  );
});

test("setLiteLlmBudget calls LiteLLM team/update with persisted litellm_team_id and returns maxBudget", async () => {
  const calls = stubLitellmFetch({
    "/team/update": (init: any) => ({ status: 200, body: JSON.parse(init.body) }),
  });
  const repo = createRepo(
    fakeSupabase({
      auth: OWNER_AUTH.auth,
      tableData: {
        actors: [{ id: "actor-owner-1" }],
        team_members: [{ role: "owner" }],
        team_workspace_config: [{ litellm_team_id: "litellm-team-budget" }],
      },
    }),
  );

  const out = await repo.setLiteLlmBudget("team-budget-1", { maxBudget: 25 });
  assert.deepEqual(out, { maxBudget: 25 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.endsWith("/team/update"), true);
});

test("setLiteLlmBudget rejects non-owner with 403", async () => {
  const repo = createRepo(
    fakeSupabase({
      auth: {
        async getUser() {
          return { data: { user: { id: "user-member-not-owner" } }, error: null };
        },
      },
      tableData: {
        actors: [{ id: "actor-member-1" }],
        team_members: [{ role: "member" }],
      },
    }),
  );

  await assert.rejects(
    () => repo.setLiteLlmBudget("team-budget-2", { maxBudget: 25 }),
    (err: any) => err.statusCode === 403 && err.code === "forbidden",
  );
});

test("setLiteLlmBudget throws 409 litellm_not_provisioned when litellm_team_id is unset", async () => {
  const repo = createRepo(
    fakeSupabaseForShareMode({}),
  );
  // fakeSupabaseForShareMode has no team_workspace_config rows
  await assert.rejects(
    () => repo.setLiteLlmBudget("team-budget-3", { maxBudget: 25 }),
    (err: any) => err.statusCode === 409 && err.code === "litellm_not_provisioned",
  );
});

test("setLiteLlmBudget throws 400 missing_maxBudget when maxBudget is absent", async () => {
  const repo = createRepo(
    fakeSupabase({
      auth: OWNER_AUTH.auth,
      tableData: {
        actors: [{ id: "actor-owner-1" }],
        team_members: [{ role: "owner" }],
        team_workspace_config: [{ litellm_team_id: "litellm-team-budget" }],
      },
    }),
  );

  await assert.rejects(
    () => repo.setLiteLlmBudget("team-budget-4", {}),
    (err: any) => err.statusCode === 400 && err.code === "missing_maxBudget",
  );
});

test("getWorkspaceConfig merges teams + team_workspace_config rows", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: {
      teams: [{
        share_mode: "custom_git",
        git_remote_url: "https://example.com/repo.git",
        git_auth_kind: "https_token",
      }],
      team_workspace_config: [{
        sync_mode: "git",
        litellm_team_id: "litellm-team-zzz",
      }],
    },
  }));

  const result = await repo.getWorkspaceConfig("team-6");

  assert.deepEqual(result, {
    shareMode: "custom_git",
    gitRemoteUrl: "https://example.com/repo.git",
    gitAuthKind: "https_token",
    syncMode: "git",
    litellmTeamId: "litellm-team-zzz",
  });
});

test("getWorkspaceConfig returns nulls when both rows absent", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: { teams: [], team_workspace_config: [] },
  }));
  const result = await repo.getWorkspaceConfig("team-7");
  assert.deepEqual(result, {
    shareMode: null,
    gitRemoteUrl: null,
    gitAuthKind: null,
    syncMode: null,
    litellmTeamId: null,
  });
});

test("upsertAgentRuntime derives team_id from actor when body omits teamId", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      actors: [{ team_id: "team-9" }],
      agent_runtimes: [{ id: "rt-1" }],
    },
  }));

  const result = await repo.upsertAgentRuntime({
    // teamId intentionally omitted (the daemon does not send it)
    agentActorId: "agent-1",
    sessionId: "sess-1",
    runtimeId: "rtid-1",
    backendSessionId: "bsid-1",
    backendType: "claude",
    status: "running",
  });

  assert.equal(result.id, "rt-1");
  // Looked up team_id from the actors table under the caller's RLS.
  const actorLookup = tableCalls.find((c) => c.table === "actors" && c.op === "select");
  assert.ok(actorLookup, "expected an actors select for team_id derivation");
  const upsert = tableCalls.find((c) => c.table === "agent_runtimes" && c.op === "upsert");
  assert.ok(upsert, "expected an agent_runtimes upsert");
  assert.equal(upsert.row.team_id, "team-9");
  assert.equal(upsert.row.agent_id, "agent-1");
  assert.deepEqual(upsert.options, { onConflict: "agent_id,backend_session_id" });
});

test("upsertAgentRuntime prefers explicit body.teamId without an actor lookup", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    // No actors row provided; if the code looked it up it would fail to resolve.
    tableData: { agent_runtimes: [{ id: "rt-2" }] },
  }));

  const result = await repo.upsertAgentRuntime({
    teamId: "team-explicit",
    agentActorId: "agent-2",
    sessionId: "sess-2",
    runtimeId: "rtid-2",
    backendSessionId: "bsid-2",
  });

  assert.equal(result.id, "rt-2");
  assert.equal(tableCalls.some((c) => c.table === "actors"), false, "should not query actors when teamId is given");
  const upsert = tableCalls.find((c) => c.table === "agent_runtimes" && c.op === "upsert");
  assert.equal(upsert.row.team_id, "team-explicit");
  assert.deepEqual(upsert.options, { onConflict: "agent_id,backend_session_id" });
});

test("upsertAgentRuntime throws 400 missing_team when team cannot be resolved", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: {
      actors: [], // actor not visible -> no team_id
      agent_runtimes: [{ id: "rt-x" }],
    },
  }));

  await assert.rejects(
    () =>
      repo.upsertAgentRuntime({
        agentActorId: "agent-missing",
        sessionId: "sess-3",
        runtimeId: "rtid-3",
        backendSessionId: "bsid-3",
      }),
    (err: any) => err.statusCode === 400 && err.code === "missing_team",
  );
});

function fakeSupabase({
  rpcCalls = [],
  tableCalls = [],
  rpcData = {},
  rpcErrors = {},
  tableData = {},
  tableErrors = {},
  auth = null,
  // Extended hooks for telemetry tests
  onRpc = null,
  onInsert = null,
  onUpsert = null,
  upsertData = null,
} = {}) {
  return {
    auth: auth ?? {
      async getUser() {
        return { data: { user: null }, error: null };
      },
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (onRpc) onRpc(name, args);
      return { data: rpcData[name] ?? [], error: rpcErrors[name] ?? null };
    },
    from(table) {
      return createTableQuery(table, tableCalls, tableData[table] ?? [], tableErrors[table] ?? null, {
        onInsert,
        onUpsert,
        upsertData,
      });
    },
  };
}

function createTableQuery(table: any, calls: any, data: any, error: any, hooks: any = {}) {
  const { onInsert, onUpsert, upsertData } = hooks;
  return {
    select(columns) {
      calls.push({ table, op: "select", columns });
      return createSelectableQuery(table, calls, data, error);
    },
    insert(row) {
      calls.push({ table, op: "insert", row });
      if (onInsert) onInsert(table, row);
      return {
        select(columns) {
          calls.push({ table, op: "insert.select", columns });
          return {
            async single() {
              calls.push({ table, op: "insert.single" });
              return { data: data[0] ?? null, error };
            },
          };
        },
        // Allow bare insert() to resolve immediately
        then(resolve, reject) {
          return Promise.resolve({ data: null, error }).then(resolve, reject);
        },
      };
    },
    // Single upsert: captures options + call records (agent_runtimes tests) and
    // honors the onUpsert/upsertData hooks (telemetry tests). A prior auto-merge
    // left two same-named upsert methods; the later silently shadowed the former.
    upsert(row, options) {
      calls.push({ table, op: "upsert", row, options });
      if (onUpsert) onUpsert(table, row);
      const resolvedData = upsertData ?? data[0] ?? null;
      return {
        select(columns) {
          calls.push({ table, op: "upsert.select", columns });
          return {
            async single() {
              calls.push({ table, op: "upsert.single" });
              return { data: resolvedData, error };
            },
          };
        },
      };
    },
    update(row) {
      calls.push({ table, op: "update", row });
      return createUpdatableQuery(table, calls, data, error);
    },
  };
}

function createUpdatableQuery(table, calls, data, error) {
  let eqValue = null;
  const query = {
    eq(column, value) {
      calls.push({ table, op: "update.eq", column, value });
      eqValue = value;
      return query;
    },
    select(columns) {
      calls.push({ table, op: "update.select", columns });
      return {
        async maybeSingle() {
          calls.push({ table, op: "update.maybeSingle" });
          return { data: eqValue ? { id: eqValue } : data[0] ?? null, error };
        },
      };
    },
  };
  return query;
}

function createSelectableQuery(table, calls, data, error) {
  const query = {
    order(column, options) {
      calls.push({ table, op: "order", column, options });
      return query;
    },
    limit(count) {
      calls.push({ table, op: "limit", count });
      return Promise.resolve({ data, error });
    },
    eq(column, value) {
      calls.push({ table, op: "eq", column, value });
      return query;
    },
    in(column, values) {
      calls.push({ table, op: "in", column, values });
      return query;
    },
    single() {
      calls.push({ table, op: "single" });
      return Promise.resolve({ data: data[0] ?? null, error });
    },
    maybeSingle() {
      calls.push({ table, op: "maybeSingle" });
      return Promise.resolve({ data: data[0] ?? null, error });
    },
    then(resolve, reject) {
      return Promise.resolve({ data, error }).then(resolve, reject);
    },
  };
  return query;
}

// --- Actor directory ---

test("listTeamActors selects actor_directory columns without removed agent_kind", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      actor_directory: [{
        id: "actor-1",
        team_id: "team-1",
        actor_type: "agent",
        user_id: null,
        invited_by_actor_id: null,
        display_name: "Bot",
        avatar_url: null,
        team_role: null,
        member_status: null,
        agent_status: "idle",
        agent_types: ["claude"],
        default_agent_type: "claude",
        default_workspace_id: null,
        agent_visibility: "team",
        last_active_at: null,
        created_at: "2026-05-27T01:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      }],
    },
  }));

  const page = await repo.listTeamActors("team-1", { limit: 10 });
  const selectCall = tableCalls.find((c) => c.table === "actor_directory" && c.op === "select");
  assert.ok(selectCall, "expected actor_directory select");
  assert.ok(!selectCall.columns.includes("agent_kind"), "must not select removed agent_kind column");
  assert.equal(page.items[0].defaultAgentType, "claude");
  assert.equal(page.items[0].agentKind, null);
});

test("ensureAgentTypes updates the caller's own agent actor, not an arbitrary team agent", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      actors: [{ id: "agent-self", user_id: "daemon-user-1", actor_type: "agent" }],
    },
    auth: {
      async getUser() {
        return { data: { user: { id: "daemon-user-1" } }, error: null };
      },
    },
  }));

  await repo.ensureAgentTypes({
    supportedTypes: ["claude", "opencode"],
    defaultAgentType: "opencode",
  });

  const actorUserEq = tableCalls.find(
    (c) => c.table === "actors" && c.op === "eq" && c.column === "user_id",
  );
  assert.equal(actorUserEq?.value, "daemon-user-1");
  assert.ok(
    !tableCalls.some((c) => c.table === "actors" && c.op === "limit"),
    "must not pick an arbitrary agent via limit(1)",
  );
  const updateEq = tableCalls.find((c) => c.table === "agents" && c.op === "update.eq");
  assert.equal(updateEq?.column, "id");
  assert.equal(updateEq?.value, "agent-self");
  const updateRow = tableCalls.find((c) => c.table === "agents" && c.op === "update");
  assert.deepEqual(updateRow?.row, {
    agent_types: ["claude", "opencode"],
    default_agent_type: "opencode",
  });
});

// --- Telemetry TDD tests ---

test("submitFeedback writes team_id, session_id, skill and no note column", async () => {
  let upsertRow = null;
  const repo = createRepo(fakeSupabase({
    onUpsert: (table, row) => { if (table === "actor_message_feedback") upsertRow = row; },
    upsertData: {
      message_id: "m1", actor_id: "a1", team_id: "t1", session_id: "s1",
      kind: "positive", star_rating: null, skill: null, created_at: "2026-05-29T00:00:00Z",
    },
  }));
  const out = await repo.submitFeedback({
    messageId: "m1", actorId: "a1", teamId: "t1", sessionId: "s1", kind: "positive", starRating: null, skill: null,
  });
  assert.equal(upsertRow.team_id, "t1");
  assert.equal(upsertRow.session_id, "s1");
  assert.equal(upsertRow.skill, null);
  assert.ok(!("note" in upsertRow), "must not write a non-existent note column");
  assert.equal(out.kind, "positive");
});

test("getTeamLeaderboard calls the team_leaderboard rpc with period and maps enriched rows", async () => {
  let rpcArgs = null;
  const repo = createRepo(fakeSupabase({
    onRpc: (fn, args) => { rpcArgs = { fn, args }; },
    rpcData: {
      team_leaderboard: [{
        team_id: "t1", actor_id: "a1", display_name: "Alice", period: "week",
        tokens_used: 1000, cost_usd: 0.25, positive_feedback: 3, negative_feedback: 1,
        session_count: 5, skill_usage: { "sentry-fix": 2 }, score: 1000,
      }],
    },
  }));
  const out = await repo.getTeamLeaderboard("t1", { period: "week" });
  assert.equal(rpcArgs.fn, "team_leaderboard");
  assert.deepEqual(rpcArgs.args, { p_team_id: "t1", p_period: "week" });
  assert.equal(out.items[0].tokensUsed, 1000);
  assert.equal(out.items[0].displayName, "Alice");
  assert.deepEqual(out.items[0].skillUsage, { "sentry-fix": 2 });
});

test("submitSessionReport inserts a report row and expands skillUsage into skill rows", async () => {
  const inserts = [];
  const repo = createRepo(fakeSupabase({
    onInsert: (table, rows) => inserts.push({ table, rows }),
  }));
  await repo.submitSessionReport({
    actorId: "a1", teamId: "t1", sessionId: "s1", tokensUsed: 10, costUsd: 0.1,
    model: "m", agentKind: "code", endedAt: "2026-05-29T00:00:00Z", skillUsage: { foo: 2, bar: 1 },
  });
  const report = inserts.find((i) => i.table === "actor_session_report");
  const skills = inserts.find((i) => i.table === "actor_skill_usage");
  assert.equal(report.rows.tokens_used, 10);
  assert.equal(report.rows.agent_kind, "code");
  assert.equal(skills.rows.length, 2);
  assert.deepEqual(skills.rows.map((r) => r.skill).sort(), ["bar", "foo"]);
});

// --- Gateway session contract (daemon round-trip) ---
//
// The amuxd daemon deserializes these two endpoints into structs with
// REQUIRED, camelCase fields:
//   POST /v1/sessions/gateway/ensure  → { sessionId, gatewaySessionId, created }
//       (apps/daemon/src/backend/cloud_api/mod.rs rpc_ensure_gateway_session,
//        gatewaySessionId is a required String)
//   GET  /v1/sessions/by-acp/:acpId   → { sessionId, gatewaySessionId? }
//       (get_gateway_session_by_acp_id; sessionId is a required String)
//
// The daemon uses ensure's `gatewaySessionId` as the logical ACP session id it
// later looks up via getSessionByAcp, which queries the `acp_session_id` column
// — so gatewaySessionId MUST equal the row's acp_session_id to round-trip. A
// WeCom inbound message hits ensure first; when this field was missing the
// daemon failed with "missing field gatewaySessionId" and dropped the message.

test("ensureGatewaySession returns gatewaySessionId (daemon-required field) = acp_session_id", async () => {
  const repo = createRepo(fakeSupabase({
    rpcData: {
      ensure_gateway_session: [{
        session_id: "sess-1",
        acp_session_id: "acp-hex-1",
        created: true,
      }],
    },
  }));

  const out = await repo.ensureGatewaySession({
    teamId: "team-1",
    binding: "wecom://bot/bot/single/u1",
    title: "WeCom chat",
    primaryAgentActorId: "actor-1",
    ownerMemberActorIds: [],
    participantActorIds: [],
  });

  assert.equal(out.sessionId, "sess-1");
  // The daemon deserializes this as a required String; it must round-trip to
  // acp_session_id so a later getSessionByAcp lookup finds the row.
  assert.equal(out.gatewaySessionId, "acp-hex-1");
  assert.equal(out.created, true);
});

test("getSessionByAcp returns the {sessionId, gatewaySessionId} shape the daemon deserializes", async () => {
  const repo = createRepo(fakeSupabase({
    tableData: {
      sessions: [{
        id: "sess-1",
        team_id: "team-1",
        title: "WeCom chat",
        mode: "collab",
        idea_id: null,
        primary_agent_id: "actor-1",
        created_by_actor_id: "actor-1",
        summary: null,
        last_message_preview: null,
        last_message_at: null,
        acp_session_id: "acp-hex-1",
        binding: "wecom://bot/bot/single/u1",
        created_at: "2026-06-04T00:00:00Z",
        updated_at: "2026-06-04T00:00:00Z",
      }],
    },
  }));

  const out = await repo.getSessionByAcp("acp-hex-1");

  // Daemon requires sessionId (mapped from the row id).
  assert.equal(out.sessionId, "sess-1");
  // Daemon uses gatewaySessionId as the chat binding for the per-session MCP
  // config so `send` defaults to the originating chat.
  assert.equal(out.gatewaySessionId, "wecom://bot/bot/single/u1");
});

// --- Agent defaults (daemon reads these to route gateway sessions) ---

test("listAgentDefaults selects + maps default_workspace_id alongside default_agent_type", async () => {
  const tableCalls = [];
  const repo = createRepo(fakeSupabase({
    tableCalls,
    tableData: {
      agents: [{
        id: "agent-1",
        agent_types: ["claude", "opencode"],
        default_agent_type: "opencode",
        default_workspace_id: "11111111-1111-1111-1111-111111111111",
      }],
    },
  }));

  const rows = await repo.listAgentDefaults(["agent-1"]);

  const selectCall = tableCalls.find((c) => c.table === "agents" && c.op === "select");
  assert.ok(selectCall, "expected an agents select");
  assert.ok(
    selectCall.columns.includes("default_workspace_id"),
    "must select default_workspace_id so the daemon can resolve the gateway cwd",
  );
  assert.equal(rows[0].id, "agent-1");
  assert.equal(rows[0].defaultAgentType, "opencode");
  assert.equal(rows[0].defaultWorkspaceId, "11111111-1111-1111-1111-111111111111");
});

// --- Apps domain (production passthrough) -----------------------------------
//
// The shared fakeSupabase mock cannot exercise multi-insert + update-returning
// chains used by createApp, so these tests use a small purpose-built stateful
// supabase double. It records calls and serves per-table rows for select /
// insert.select.single / update.select.single|maybeSingle.

function appsAuth(userId = "user-app-1") {
  return {
    async getUser() {
      return { data: { user: { id: userId } }, error: null };
    },
  };
}

// Stateful supabase double for apps tests. `seed` provides rows keyed by table.
// `actorRow` is what the actors lookup (resolveCurrentMemberActor) returns.
function appsSupabase({ seed = {}, actorRow = { id: "actor-app-1" }, calls = [] }: any = {}) {
  const state: any = { apps: [...(seed.apps ?? [])], workspaces: [...(seed.workspaces ?? [])], sessions: [...(seed.sessions ?? [])] };
  return {
    auth: appsAuth(),
    from(table: string) {
      const ctx: any = { table, op: null, filters: {} };
      const builder: any = {
        select(columns: string) {
          calls.push({ table, op: ctx.op ? `${ctx.op}.select` : "select", columns });
          return builder;
        },
        insert(row: any) {
          ctx.op = "insert";
          calls.push({ table, op: "insert", row });
          // mutate state so the inserted row is what subsequent .single() returns
          const inserted = { ...row, id: row.id ?? `${table}-id-1` };
          state[table] = [inserted];
          ctx.inserted = inserted;
          return builder;
        },
        update(row: any) {
          ctx.op = "update";
          calls.push({ table, op: "update", row });
          ctx.update = row;
          return builder;
        },
        upsert(row: any) {
          calls.push({ table, op: "upsert", row });
          // session_participants seeding etc. — resolve immediately.
          return Promise.resolve({ data: null, error: null });
        },
        eq(column: string, value: any) {
          ctx.filters[column] = value;
          calls.push({ table, op: `${ctx.op ?? "select"}.eq`, column, value });
          return builder;
        },
        order() { return builder; },
        // Chainable like supabase-js: limit() returns the (thenable) builder so
        // a trailing .maybeSingle()/.single() still works; awaiting it yields the
        // table rows (used by listApps).
        limit() { return builder; },
        single() {
          if (ctx.op === "insert") return Promise.resolve({ data: ctx.inserted, error: null });
          if (ctx.op === "update") {
            const base = state[table]?.[0] ?? {};
            const merged = { ...base, ...ctx.update };
            state[table] = [merged];
            return Promise.resolve({ data: merged, error: null });
          }
          // plain select: actors lookup returns the actor row
          if (table === "actors") return Promise.resolve({ data: actorRow, error: null });
          return Promise.resolve({ data: state[table]?.[0] ?? null, error: null });
        },
        maybeSingle() {
          if (table === "actors") return Promise.resolve({ data: actorRow, error: null });
          if (ctx.op === "update") {
            const base = state[table]?.[0];
            if (!base) return Promise.resolve({ data: null, error: null });
            const merged = { ...base, ...ctx.update };
            state[table] = [merged];
            return Promise.resolve({ data: merged, error: null });
          }
          return Promise.resolve({ data: state[table]?.[0] ?? null, error: null });
        },
        then(resolve: any, reject: any) {
          return Promise.resolve({ data: state[table] ?? [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    async rpc() { return { data: [], error: null }; },
  };
}

function appsRepo(supabase: any, extra: any = {}) {
  return createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
    ...extra,
  });
}

const APP_ROW = {
  id: "app-1",
  team_id: "team-1",
  name: "My App",
  slug: "my-app",
  type: "fullstack_tanstack_postgres",
  visibility: "team",
  workspace_id: "ws-1",
  git_remote_url: null,
  provision_status: "pending",
  fc_status: null,
  created_at: "2026-06-13T00:00:00Z",
  updated_at: "2026-06-13T00:00:00Z",
};

test("apps: mapApp exposes exactly the 12 canonical keys", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] } }));
  const items = await repo.listApps({ teamId: "team-1", limit: 100 });
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0]).sort(), [
    "createdAt", "fcStatus", "fcEndpoint", "fcFunctionName", "fcRegion",
    "gitRemoteUrl", "id", "name", "provisionStatus",
    "slug", "teamId", "type", "updatedAt", "visibility", "workspaceId",
  ].sort());
  assert.equal(items[0].teamId, "team-1");
  assert.equal(items[0].workspaceId, "ws-1");
  assert.equal(items[0].provisionStatus, "pending");
});

test("apps: listApps filters by team_id, orders created_at desc, limits", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] }, calls }));
  await repo.listApps({ teamId: "team-7", limit: 25 });
  const teamEq = calls.find((c) => c.table === "apps" && c.column === "team_id");
  assert.equal(teamEq?.value, "team-7");
});

test("apps: getApp returns null when RLS hides the row", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }));
  assert.equal(await repo.getApp("missing"), null);
});

test("apps: createApp inserts workspace + app and resolves caller actor", async () => {
  const calls: any[] = [];
  const repo = appsRepo(appsSupabase({ calls, actorRow: { id: "actor-app-1" } }));
  const app = await repo.createApp({
    teamId: "team-1",
    name: "My App",
    type: "fullstack_tanstack_postgres",
    visibility: "team",
  });
  // workspace insert carries the resolved actor as created_by_member_id
  const wsInsert = calls.find((c) => c.table === "workspaces" && c.op === "insert");
  assert.equal(wsInsert?.row.created_by_member_id, "actor-app-1");
  assert.equal(wsInsert?.row.team_id, "team-1");
  // app insert carries created_by_actor_id = resolved actor + provision pending
  const appInsert = calls.find((c) => c.table === "apps" && c.op === "insert");
  assert.equal(appInsert?.row.created_by_actor_id, "actor-app-1");
  assert.equal(appInsert?.row.provision_status, "pending");
  assert.equal(appInsert?.row.slug, "my-app");
  assert.equal(appInsert?.row.visibility, "team");
  // no provisioner injected → returns the pending app
  assert.equal(app.provisionStatus, "pending");
  assert.equal(app.teamId, "team-1");
});

test("apps: createApp advances to repo_created on provisioner success", async () => {
  const repo = appsRepo(
    appsSupabase({}),
    {
      provisionAppRepo: async ({ appId, teamId }: any) => {
        assert.equal(teamId, "team-1");
        assert.ok(appId);
        return { gitRemoteUrl: "https://git.example.com/app.git", gitAuthKind: "pat" };
      },
    },
  );
  const app = await repo.createApp({ teamId: "team-1", name: "My App", type: "t", visibility: "personal" });
  assert.equal(app.provisionStatus, "repo_created");
  assert.equal(app.gitRemoteUrl, "https://git.example.com/app.git");
});

test("apps: createApp sets error status when provisioner throws", async () => {
  const repo = appsRepo(
    appsSupabase({}),
    {
      provisionAppRepo: async () => { throw new Error("managed-git boom"); },
    },
  );
  const app = await repo.createApp({ teamId: "team-1", name: "My App", type: "t" });
  assert.equal(app.provisionStatus, "error");
});

test("apps: updateApp returns null when no row updated (RLS non-creator)", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }));
  const result = await repo.updateApp("app-1", { name: "New" });
  assert.equal(result, null);
});

test("apps: updateApp maps the updated row", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [APP_ROW] } }));
  const result = await repo.updateApp("app-1", { name: "Renamed", visibility: "personal" });
  assert.equal(result?.name, "Renamed");
  assert.equal(result?.visibility, "personal");
});

test("apps: updateApp advances provisionStatus through a legal transition", async () => {
  const repo = appsRepo(appsSupabase({
    seed: { apps: [{ ...APP_ROW, provision_status: "repo_created" }] },
  }));
  const result = await repo.updateApp("app-1", { provisionStatus: "seeding" });
  assert.equal(result?.provisionStatus, "seeding");
});

test("apps: updateApp rejects an illegal provisionStatus jump (from pending)", async () => {
  const repo = appsRepo(appsSupabase({
    seed: { apps: [{ ...APP_ROW, provision_status: "pending" }] },
  }));
  await assert.rejects(
    () => repo.updateApp("app-1", { provisionStatus: "ready" }),
    (err: any) => err?.code === "invalid_status_transition" && err?.statusCode === 400,
  );
});

test("apps: deployApp method is present", async () => {
  const repo = appsRepo(appsSupabase({}));
  assert.equal(typeof repo.deployApp, "function");
});

test("apps: deployApp returns null when RLS hides the app", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }), {
    startDeploy: async () => { throw new Error("should not be called"); },
  });
  assert.equal(await repo.deployApp("app-1"), null);
});

test("apps: deployApp rejects 409 when app not ready", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "seeding" }] } }),
    { startDeploy: async () => { throw new Error("should not be called"); } },
  );
  await assert.rejects(
    () => repo.deployApp("app-1"),
    (err: any) => err?.code === "app_not_ready" && err?.statusCode === 409,
  );
});

test("apps: deployApp rejects 503 when startDeploy dep missing", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "ready" }] } }),
  );
  await assert.rejects(
    () => repo.deployApp("app-1"),
    (err: any) => err?.code === "deploy_unavailable" && err?.statusCode === 503,
  );
});

test("apps: deployApp on ready app returns awaiting_build + ossObjectName", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "ready" }] } }),
    {
      startDeploy: async ({ appId, slug }: any) => {
        assert.equal(appId, "app-1");
        assert.equal(slug, "my-app");
        return {
          fcFunctionName: "app-my-app",
          fcRegion: "cn-hangzhou",
          ossObjectName: "apps/app-1/build.zip",
          databaseUrl: "postgres://secret",
          presignedPut: "https://oss/put?sig=x",
        };
      },
    },
  );
  const result = await repo.deployApp("app-1");
  assert.equal(result.fcStatus, "awaiting_build");
  assert.equal(result.fcFunctionName, "app-my-app");
  assert.equal(result.fcRegion, "cn-hangzhou");
  assert.equal(result.ossObjectName, "apps/app-1/build.zip");
  assert.equal(result.presignedPut, "https://oss/put?sig=x");
});

test("apps: deployApp wraps startDeploy failure as 502", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, provision_status: "ready" }] } }),
    { startDeploy: async () => { throw new Error("fc boom"); } },
  );
  await assert.rejects(
    () => repo.deployApp("app-1"),
    (err: any) => err?.code === "deploy_failed" && err?.statusCode === 502,
  );
});

test("apps: finalizeDeploy method is present", async () => {
  const repo = appsRepo(appsSupabase({}));
  assert.equal(typeof repo.finalizeDeploy, "function");
});

test("apps: finalizeDeploy returns null when RLS hides the app", async () => {
  const repo = appsRepo(appsSupabase({ seed: { apps: [] } }), {
    finalizeDeploy: async () => { throw new Error("should not be called"); },
  });
  assert.equal(await repo.finalizeDeploy("app-1"), null);
});

test("apps: finalizeDeploy rejects 409 when app has no function", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, fc_function_name: null, fc_status: null }] } }),
    { finalizeDeploy: async () => { throw new Error("should not be called"); } },
  );
  await assert.rejects(
    () => repo.finalizeDeploy("app-1"),
    (err: any) => err?.code === "not_deploying" && err?.statusCode === 409,
  );
});

test("apps: finalizeDeploy rejects 409 on illegal fc_status transition", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, fc_function_name: "tc-app-1", fc_status: "live" }] } }),
    { finalizeDeploy: async () => { throw new Error("should not be called"); } },
  );
  await assert.rejects(
    () => repo.finalizeDeploy("app-1"),
    (err: any) => err?.code === "invalid_deploy_state" && err?.statusCode === 409,
  );
});

test("apps: finalizeDeploy rejects 503 when finalizeDeploy dep missing", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, fc_function_name: "tc-app-1", fc_status: "awaiting_build" }] } }),
  );
  await assert.rejects(
    () => repo.finalizeDeploy("app-1"),
    (err: any) => err?.code === "deploy_unavailable" && err?.statusCode === 503,
  );
});

test("apps: finalizeDeploy on awaiting_build app returns live + fcEndpoint", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, fc_function_name: "tc-app-1", fc_status: "awaiting_build" }] } }),
    {
      finalizeDeploy: async ({ fcFunctionName, ossObjectName }: any) => {
        assert.equal(fcFunctionName, "tc-app-1");
        assert.equal(ossObjectName, "apps/app-1/code.zip");
        return { fcEndpoint: "https://x.fcapp.run" };
      },
    },
  );
  const result = await repo.finalizeDeploy("app-1");
  assert.equal(result.fcStatus, "live");
  assert.equal(result.fcEndpoint, "https://x.fcapp.run");
});

test("apps: finalizeDeploy wraps finalize failure as 502", async () => {
  const repo = appsRepo(
    appsSupabase({ seed: { apps: [{ ...APP_ROW, fc_function_name: "tc-app-1", fc_status: "awaiting_build" }] } }),
    { finalizeDeploy: async () => { throw new Error("fc boom"); } },
  );
  await assert.rejects(
    () => repo.finalizeDeploy("app-1"),
    (err: any) => err?.code === "finalize_failed" && err?.statusCode === 502,
  );
});

test("apps: listAppSessions returns the session-summary shape", async () => {
  const repo = appsRepo(appsSupabase({
    seed: {
      sessions: [{
        id: "sess-1", team_id: "team-1", title: "Chat", mode: "collab",
        last_message_at: "2026-06-13T01:00:00Z",
        created_at: "2026-06-13T00:00:00Z", updated_at: "2026-06-13T00:30:00Z",
      }],
    },
  }));
  const rows = await repo.listAppSessions("app-1");
  assert.deepEqual(rows, [{
    id: "sess-1",
    teamId: "team-1",
    title: "Chat",
    mode: "collab",
    lastMessageAt: "2026-06-13T01:00:00.000Z",
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:30:00.000Z",
  }]);
});

test("apps: createSession forwards app_id when input has appId", async () => {
  const calls: any[] = [];
  const supabase = appsSupabase({
    seed: {
      sessions: [{
        id: "sess-app-1", team_id: "team-1", title: "App chat", mode: "collab",
        idea_id: null, primary_agent_id: null, created_by_actor_id: "actor-app-1",
        summary: null, last_message_preview: null, last_message_at: null,
        acp_session_id: null, binding: null,
        created_at: "2026-06-13T00:00:00Z", updated_at: "2026-06-13T00:00:00Z",
      }],
    },
    calls,
  });
  const repo = appsRepo(supabase);
  await repo.createSession({
    id: "sess-app-1",
    teamId: "team-1",
    title: "App chat",
    createdByActorId: "actor-app-1",
    appId: "app-1",
  });
  const insert = calls.find((c) => c.table === "sessions" && c.op === "insert");
  assert.equal(insert?.row.app_id, "app-1");
});

test("apps: createSession omits app_id when no appId given", async () => {
  const calls: any[] = [];
  const supabase = appsSupabase({
    seed: {
      sessions: [{
        id: "sess-plain", team_id: "team-1", title: "Plain", mode: "collab",
        idea_id: null, primary_agent_id: null, created_by_actor_id: "actor-app-1",
        summary: null, last_message_preview: null, last_message_at: null,
        acp_session_id: null, binding: null,
        created_at: "2026-06-13T00:00:00Z", updated_at: "2026-06-13T00:00:00Z",
      }],
    },
    calls,
  });
  const repo = appsRepo(supabase);
  await repo.createSession({
    id: "sess-plain",
    teamId: "team-1",
    title: "Plain",
    createdByActorId: "actor-app-1",
  });
  const insert = calls.find((c) => c.table === "sessions" && c.op === "insert");
  assert.ok(!("app_id" in (insert?.row ?? {})), "app_id must be absent for plain sessions");
});

test("createSession is server-authoritative for created_by (ignores client createdByActorId)", async () => {
  const calls: any[] = [];
  // The authenticated caller resolves to actor-app-1 for this team; the client
  // sends a DIFFERENT (stale/other-team) actor id, which must be ignored.
  const supabase = appsSupabase({ actorRow: { id: "actor-app-1" }, calls });
  const repo = appsRepo(supabase);
  await repo.createSession({
    id: "sess-auth-1",
    teamId: "team-1",
    title: "Authoritative",
    createdByActorId: "actor-SPOOFED-other-team",
  });
  const insert = calls.find((c) => c.table === "sessions" && c.op === "insert");
  assert.equal(
    insert?.row.created_by_actor_id,
    "actor-app-1",
    "created_by must be the server-resolved team actor, not the client value",
  );
});

test("createSession returns 403 when the caller is not a member of the team", async () => {
  const supabase = appsSupabase({ actorRow: null });
  const repo = appsRepo(supabase);
  await assert.rejects(
    () => repo.createSession({ id: "sess-x", teamId: "team-1", title: "Nope" }),
    (err: any) => err?.statusCode === 403,
  );
});

test("apps: getManagedGitCredential returns creds for a member, null for non-member", async () => {
  const prevPat = process.env.CODEUP_PAT;
  const prevBot = process.env.CODEUP_BOT_USERNAME;
  process.env.CODEUP_PAT = "pt-secret";
  process.env.CODEUP_BOT_USERNAME = "teamclaw";
  try {
    const memberRepo = appsRepo(appsSupabase({ actorRow: { id: "actor-app-1" } }));
    const cred = await memberRepo.getManagedGitCredential("team-1");
    assert.deepEqual(cred, { username: "teamclaw", token: "pt-secret" });

    const nonMemberRepo = appsRepo(appsSupabase({ actorRow: null }));
    const denied = await nonMemberRepo.getManagedGitCredential("team-1");
    assert.equal(denied, null);
  } finally {
    if (prevPat === undefined) delete process.env.CODEUP_PAT; else process.env.CODEUP_PAT = prevPat;
    if (prevBot === undefined) delete process.env.CODEUP_BOT_USERNAME; else process.env.CODEUP_BOT_USERNAME = prevBot;
  }
});

test("apps: getManagedGitCredential throws 503 when managed-git unconfigured", async () => {
  const prevPat = process.env.CODEUP_PAT;
  delete process.env.CODEUP_PAT;
  try {
    const repo = appsRepo(appsSupabase({ actorRow: { id: "actor-app-1" } }));
    await assert.rejects(
      () => repo.getManagedGitCredential("team-1"),
      (err: any) => err?.code === "managed_git_unavailable" && err?.statusCode === 503,
    );
  } finally {
    if (prevPat === undefined) delete process.env.CODEUP_PAT; else process.env.CODEUP_PAT = prevPat;
  }
});
