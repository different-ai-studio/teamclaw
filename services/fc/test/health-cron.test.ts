import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

function deps(over: Record<string, any> = {}) {
  return {
    createRepository: () => ({}),
    createAuthRepository: () => ({}),
    ...over,
  } as any;
}

test("GET /healthz returns 200 ok:true", async () => {
  const app = createApp(deps());
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /internal/cron rejects without secret", async () => {
  process.env.CRON_TRIGGER_SECRET = "s3cret";
  const app = createApp(deps());
  const res = await app.request("/internal/cron", {
    method: "POST",
    body: JSON.stringify({ task: "oss-gc-blobs" }),
  });
  assert.equal(res.status, 401);
});

test("POST /internal/cron rejects wrong secret", async () => {
  process.env.CRON_TRIGGER_SECRET = "s3cret";
  const app = createApp(deps());
  const res = await app.request("/internal/cron", {
    method: "POST",
    headers: { "x-cron-secret": "nope" },
    body: JSON.stringify({ task: "oss-gc-blobs" }),
  });
  assert.equal(res.status, 401);
});

test("POST /internal/cron runs task with correct secret", async () => {
  process.env.CRON_TRIGGER_SECRET = "s3cret";
  let called = "";
  const app = createApp(deps({ runCron: async (t: string) => { called = t; return { ok: 1 }; } }));
  const res = await app.request("/internal/cron", {
    method: "POST",
    headers: { "x-cron-secret": "s3cret" },
    body: JSON.stringify({ task: "oss-gc-blobs" }),
  });
  assert.equal(res.status, 200);
  assert.equal(called, "oss-gc-blobs");
  assert.deepEqual(await res.json(), { ok: 1 });
});

test("POST /internal/cron 400 on unknown task", async () => {
  process.env.CRON_TRIGGER_SECRET = "s3cret";
  const app = createApp(deps({
    runCron: async (t: string) => { throw new Error(`Unknown cron task: ${t}`); },
  }));
  const res = await app.request("/internal/cron", {
    method: "POST",
    headers: { "x-cron-secret": "s3cret" },
    body: JSON.stringify({ task: "bogus" }),
  });
  assert.equal(res.status, 400);
});
