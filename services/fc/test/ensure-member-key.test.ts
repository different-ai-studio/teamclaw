import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureMemberKeyFor } from "../src/lib/team-provisioning.js";

// litellmFetch 由 fetch 驱动；用 globalThis.fetch stub 记录调用。
function stubFetch(routes: Record<string, (init: any) => { status: number; body: any }>) {
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

test("ensureMemberKeyFor: existing key is not regenerated", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  const calls = stubFetch({
    "/key/info": () => ({ status: 200, body: { info: { key_name: "sk-tc-abc" } } }),
    "/key/generate": () => ({ status: 200, body: { key: "sk-tc-should-not-happen" } }),
  });
  const out = await ensureMemberKeyFor("tc-team1", "abc");
  assert.equal(out.key, "sk-tc-abc");
  assert.equal(out.aiGatewayEndpoint, "https://ai.example/v1");
  assert.ok(!calls.some((c) => c.url.includes("/key/generate")), "must not call /key/generate");
});

test("ensureMemberKeyFor: missing key is generated once", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  const calls = stubFetch({
    "/key/info": () => ({ status: 404, body: { error: { code: "404" } } }),
    "/key/generate": () => ({ status: 200, body: { key: "sk-tc-abc" } }),
  });
  const out = await ensureMemberKeyFor("tc-team1", "abc");
  assert.equal(out.key, "sk-tc-abc");
  assert.equal(calls.filter((c) => c.url.includes("/key/generate")).length, 1);
});

test("ensureMemberKeyFor: generate 409 treated as success", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  stubFetch({
    "/key/info": () => ({ status: 404, body: {} }),
    "/key/generate": () => ({ status: 409, body: { error: { message: "already exists" } } }),
  });
  const out = await ensureMemberKeyFor("tc-team1", "abc");
  assert.equal(out.key, "sk-tc-abc");
});
