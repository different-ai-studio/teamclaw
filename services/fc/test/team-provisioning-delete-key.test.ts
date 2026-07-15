/**
 * team-provisioning-delete-key.test.ts
 *
 * Tests for `deleteMemberKey` (folded into removeTeamActor, replacing the
 * legacy /ai/remove-member endpoint). Best-effort: swallows LiteLLM errors
 * via console.warn and never throws.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteMemberKey } from "../src/lib/team-provisioning.js";

function stubLitellmFetch(routes: Record<string, (init: any) => { status: number; body: any }>) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  globalThis.fetch = (async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    const path = new URL(url).pathname;
    const match = Object.keys(routes).find((r) => path.startsWith(r));
    const { status, body: respBody } = match ? routes[path] ?? routes[match](init) : { status: 404, body: {} };
    return { ok: status < 400, status, text: async () => JSON.stringify(respBody) } as any;
  }) as any;
  return calls;
}

test("deleteMemberKey calls /key/delete with the deterministic sk-tc key value", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  const calls = stubLitellmFetch({
    "/key/delete": () => ({ status: 200, body: { deleted: 1 } }),
  });

  const actorId = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef"; // > 40 chars
  await deleteMemberKey(actorId);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/key\/delete$/);
  assert.deepEqual(calls[0].body, { keys: [`sk-tc-${actorId.slice(0, 40)}`] });
});

test("deleteMemberKey never throws — swallows LiteLLM failures", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  stubLitellmFetch({
    "/key/delete": () => ({ status: 500, body: { error: "boom" } }),
  });

  await assert.doesNotReject(() => deleteMemberKey("actor-x"));
});

test("deleteMemberKey never throws — swallows network errors", async () => {
  process.env.LITELLM_MASTER_KEY = "sk-master";
  process.env.LITELLM_URL = "https://ai.example";
  globalThis.fetch = (async () => { throw new Error("network down"); }) as any;

  await assert.doesNotReject(() => deleteMemberKey("actor-y"));
});
