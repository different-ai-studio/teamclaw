import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureMemberKeyFor } from "../src/lib/team-provisioning.js";

// litellmFetch 由 fetch 驱动；用 globalThis.fetch stub 记录调用。
function stubFetch(routes: Record<string, (init: any) => { status: number; body: any }>) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    const path = new URL(url).pathname + (new URL(url).search || "");
    const match = Object.keys(routes).find((r) => path.startsWith(r));
    const { status, body } = match ? routes[match](init) : { status: 404, body: {} };
    return { ok: status < 400, status, text: async () => JSON.stringify(body) } as any;
  }) as any;
  return calls;
}

const callTo = (calls: Array<{ url: string; body: any }>, path: string) =>
  calls.filter((c) => c.url.includes(path));

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
    "/user/new": () => ({ status: 200, body: {} }),
    "/key/generate": () => ({ status: 409, body: { error: { message: "already exists" } } }),
  });
  const out = await ensureMemberKeyFor("tc-team1", "abc");
  assert.equal(out.key, "sk-tc-abc");
});

// Attribution: the key must carry the FULL actor id as user_id. The 8-char
// key_alias prefix is display only — usage reporting groups by user_id.
test("ensureMemberKeyFor: new key carries user_id = actor id", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  const actorId = "aaaaaaaa-1111-4111-8111-111111111111";
  const calls = stubFetch({
    "/key/info": () => ({ status: 404, body: {} }),
    "/user/new": () => ({ status: 200, body: {} }),
    "/key/generate": () => ({ status: 200, body: { key: `sk-tc-${actorId}` } }),
  });
  await ensureMemberKeyFor("tc-team1", actorId);

  const gen = callTo(calls, "/key/generate")[0];
  assert.equal(gen.body.user_id, actorId, "full uuid, not the alias prefix");
  assert.equal(gen.body.key_alias, "member-aaaaaaaa");

  // The internal user is registered first — LiteLLM's docs never promise
  // /key/generate auto-creates an unknown user_id.
  const userNew = callTo(calls, "/user/new")[0];
  assert.ok(userNew, "must register the internal user before generating");
  assert.equal(userNew.body.auto_create_key, false, "an auto key would be a phantom usage row");
});

test("ensureMemberKeyFor: falls back to an unowned key if the gateway rejects user_id", async () => {
  // A working credential outranks attribution: a daemon with no key is broken,
  // a daemon with an unowned key just reports as unattributed.
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  const calls = stubFetch({
    "/key/info": () => ({ status: 404, body: {} }),
    "/user/new": () => ({ status: 500, body: { error: "boom" } }),
    "/key/generate": (init: any) =>
      JSON.parse(init.body).user_id
        ? { status: 400, body: { error: { message: "unknown user_id" } } }
        : { status: 200, body: { key: "sk-tc-abc" } },
  });
  const out = await ensureMemberKeyFor("tc-team1", "abc");
  assert.equal(out.key, "sk-tc-abc", "member still gets a usable key");
  assert.equal(callTo(calls, "/key/generate").length, 2, "owned attempt, then unowned retry");
});

test("ensureMemberKeyFor: still throws when the key cannot be created at all", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  stubFetch({
    "/key/info": () => ({ status: 404, body: {} }),
    "/user/new": () => ({ status: 200, body: {} }),
    "/key/generate": () => ({ status: 500, body: { error: { message: "down" } } }),
  });
  await assert.rejects(
    () => ensureMemberKeyFor("tc-team1", "abc"),
    (e: any) => e?.code === "litellm_key_generate_failed" && e?.statusCode === 502,
  );
});

test("ensureMemberKeyFor: backfills user_id onto a pre-attribution key", async () => {
  // Because user_id lives on the key, this retroactively attributes that key's
  // whole spend history — no spend-log rewrite involved.
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  const calls = stubFetch({
    "/key/info": () => ({ status: 200, body: { info: { key_name: "sk-tc-abc" } } }),
    "/user/new": () => ({ status: 200, body: {} }),
    "/key/update": () => ({ status: 200, body: {} }),
  });
  const out = await ensureMemberKeyFor("tc-team1", "abc");
  assert.equal(out.key, "sk-tc-abc");
  const upd = callTo(calls, "/key/update")[0];
  assert.equal(upd.body.user_id, "abc");
  assert.ok(!calls.some((c) => c.url.includes("/key/generate")), "must not regenerate");
});

test("ensureMemberKeyFor: already-owned key is left alone", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  const calls = stubFetch({
    "/key/info": () => ({ status: 200, body: { info: { key_name: "sk-tc-abc", user_id: "abc" } } }),
  });
  await ensureMemberKeyFor("tc-team1", "abc");
  assert.equal(callTo(calls, "/key/update").length, 0, "no redundant write on the steady path");
});

test("ensureMemberKeyFor: backfill failure never blocks the key handout", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  stubFetch({
    "/key/info": () => ({ status: 200, body: { info: { key_name: "sk-tc-abc" } } }),
    "/user/new": () => ({ status: 500, body: {} }),
    "/key/update": () => ({ status: 500, body: {} }),
  });
  const out = await ensureMemberKeyFor("tc-team1", "abc");
  assert.equal(out.key, "sk-tc-abc");
});
