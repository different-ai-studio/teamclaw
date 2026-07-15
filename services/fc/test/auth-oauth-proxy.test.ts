import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { createSupabaseAuthRepository } from "../src/lib/supabase-repo.js";

function authDeps(fetchImpl) {
  const auth = createSupabaseAuthRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "anon-key",
    fetchImpl,
    createClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
  });
  return {
    createRepository: () => { throw new Error("business repo not expected"); },
    createAuthRepository: () => auth,
  };
}

test("GET /v1/auth/oauth/google/authorize 302s to GoTrue authorize", async () => {
  const deps = authDeps(async () => new Response("{}", { status: 200 }));
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/auth/oauth/google/authorize",
    queryParameters: { redirect: "teamclaw://auth-callback", code_challenge: "CH" },
    headers: {},
    body: null,
  }, deps);
  assert.equal(res.statusCode, 302);
  const loc = (res.headers as any).Location;
  assert.ok(loc.startsWith("https://example.supabase.co/auth/v1/authorize?"));
  const u = new URL(loc);
  assert.equal(u.searchParams.get("provider"), "google");
  assert.equal(u.searchParams.get("redirect_to"), "teamclaw://auth-callback");
  assert.equal(u.searchParams.get("code_challenge"), "CH");
  assert.equal(u.searchParams.get("code_challenge_method"), "s256");
});

test("authorize redirect uses supabasePublicUrl when set (browser-reachable), not the internal supabaseUrl", async () => {
  const auth = createSupabaseAuthRepository({
    supabaseUrl: "http://172.18.29.136", // internal/VPC — browser can't reach
    supabasePublicUrl: "https://amuxsupa.ucar.cc", // public
    publishableKey: "anon-key",
    fetchImpl: async () => new Response("{}", { status: 200 }),
    createClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
  });
  const deps = {
    createRepository: () => { throw new Error("business repo not expected"); },
    createAuthRepository: () => auth,
  };
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/auth/oauth/wechat/authorize",
    queryParameters: { redirect: "http://127.0.0.1:54172/callback", code_challenge: "CH" },
    headers: {},
    body: null,
  }, deps);
  assert.equal(res.statusCode, 302);
  const loc = (res.headers as any).Location;
  assert.ok(loc.startsWith("https://amuxsupa.ucar.cc/auth/v1/authorize?"), `unexpected location: ${loc}`);
  assert.ok(!loc.includes("172.18.29.136"), "browser redirect must not use the internal supabaseUrl");
});

test("POST /v1/auth/oauth/exchange exchanges PKCE code for tokens", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 3600,
      user: { id: "u1", email: "g@b.com", is_anonymous: false },
    }), { status: 200 });
  };
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/auth/oauth/exchange", headers: {},
    body: JSON.stringify({ code: "PKCE_CODE", codeVerifier: "VERIFIER" }),
  }, authDeps(fetchImpl));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).access_token, "at");
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/auth/v1/token");
  assert.equal(u.searchParams.get("grant_type"), "pkce");
  assert.deepEqual(JSON.parse(calls[0].init.body), { auth_code: "PKCE_CODE", code_verifier: "VERIFIER" });
});

test("POST /v1/auth/oauth/exchange rejects missing fields", async () => {
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/auth/oauth/exchange", headers: {},
    body: JSON.stringify({ code: "x" }),
  }, authDeps(async () => new Response("{}", { status: 200 })));
  assert.equal(res.statusCode, 400);
});

test("GET /v1/auth/oauth/google/authorize 400s when redirect is missing", async () => {
  const deps = authDeps(async () => new Response("{}", { status: 200 }));
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/auth/oauth/google/authorize",
    queryParameters: { code_challenge: "CH" },
    headers: {},
    body: null,
  }, deps);
  assert.equal(res.statusCode, 400);
});

test("GET /v1/auth/oauth/google/authorize 400s when code_challenge is missing", async () => {
  const deps = authDeps(async () => new Response("{}", { status: 200 }));
  const res = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/auth/oauth/google/authorize",
    queryParameters: { redirect: "teamclaw://auth-callback" },
    headers: {},
    body: null,
  }, deps);
  assert.equal(res.statusCode, 400);
});
