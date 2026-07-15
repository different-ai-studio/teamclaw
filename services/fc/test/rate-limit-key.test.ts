import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClientIp } from "../src/lib/rate-limit.js";
import { createApp } from "../src/app.js";

function headers(h: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => lower[name.toLowerCase()];
}

test("resolveClientIp prefers x-fc-client-ip over forwarded headers", () => {
  const r = resolveClientIp(headers({
    "X-Fc-Client-Ip": "203.0.113.1",
    "X-Forwarded-For": "198.51.100.9, 10.0.0.1",
    "X-Real-Ip": "192.0.2.3",
  }));
  assert.deepEqual(r, { ip: "203.0.113.1", source: "x-fc-client-ip" });
});

test("resolveClientIp falls back to first x-forwarded-for hop, then x-real-ip", () => {
  assert.deepEqual(
    resolveClientIp(headers({ "X-Forwarded-For": " 198.51.100.9 , 10.0.0.1" })),
    { ip: "198.51.100.9", source: "x-forwarded-for" },
  );
  assert.deepEqual(
    resolveClientIp(headers({ "X-Real-Ip": "192.0.2.3" })),
    { ip: "192.0.2.3", source: "x-real-ip" },
  );
  assert.deepEqual(resolveClientIp(headers({})), { ip: null, source: "none" });
});

// A client with no IP header at all must not share one global bucket across
// endpoints: exhausting one path's budget (60/min for the shared fallback)
// leaves other paths reachable.
test("headerless clients rate limit per path at 60/min, not globally", async () => {
  const app = createApp({
    createRepository: () => ({}),
    createAuthRepository: () => ({}),
  });
  for (let i = 0; i < 60; i++) {
    const res = await app.request("/unknown-bucket-path-a");
    assert.equal(res.status, 404, `request ${i + 1} within budget`);
  }
  const throttled = await app.request("/unknown-bucket-path-a");
  assert.equal(throttled.status, 429);
  // Different path → different bucket → still served.
  const other = await app.request("/unknown-bucket-path-b");
  assert.equal(other.status, 404);
});
