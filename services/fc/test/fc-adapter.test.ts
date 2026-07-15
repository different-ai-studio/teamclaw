import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { handler, normalizeFcEvent } from "../src/index.js";

function fcEvent(method: string, path: string, opts: { headers?: any; body?: any } = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: opts.headers ?? {},
    body: opts.body ? JSON.stringify(opts.body) : "",
    isBase64Encoded: false,
    queryStringParameters: {},
  };
}

test("OPTIONS -> 204", async () => {
  const res: any = await handler(fcEvent("OPTIONS", "/v1/teams"), {});
  assert.equal(res.statusCode, 204);
});

test("unknown /v1 route -> 404 envelope", async () => {
  const res: any = await handler(fcEvent("GET", "/v1/nope", { headers: { authorization: "Bearer x" } }), {});
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error.code, "not_found");
});

test("Buffer event is parsed", async () => {
  const ev = Buffer.from(JSON.stringify(fcEvent("OPTIONS", "/v1/teams")));
  const res: any = await handler(ev, {});
  assert.equal(res.statusCode, 204);
});

test("string event is parsed", async () => {
  const ev = JSON.stringify(fcEvent("OPTIONS", "/v1/teams"));
  const res: any = await handler(ev, {});
  assert.equal(res.statusCode, 204);
});

// ---- normalizeFcEvent unit tests (deterministic, no env/network) ----

test("normalizeFcEvent: backfills rawQueryString from queryStringParameters when absent", () => {
  const event = {
    rawPath: "/sync/versions",
    queryStringParameters: { teamId: "t1", path: "/foo" },
  };
  normalizeFcEvent(event as any);
  const params = new URLSearchParams((event as any).rawQueryString);
  assert.equal(params.get("teamId"), "t1");
  assert.equal(params.get("path"), "/foo");
});

test("normalizeFcEvent: does NOT clobber existing rawQueryString", () => {
  const event = {
    rawPath: "/sync/versions",
    rawQueryString: "teamId=existing",
    queryStringParameters: { teamId: "other" },
  };
  normalizeFcEvent(event as any);
  assert.equal((event as any).rawQueryString, "teamId=existing");
});

test("normalizeFcEvent: leaves event unchanged when both are absent", () => {
  const event = { rawPath: "/sync/versions" };
  normalizeFcEvent(event as any);
  assert.equal((event as any).rawQueryString, undefined);
});

test("normalizeFcEvent: leaves event unchanged when queryStringParameters is empty object", () => {
  const event = { rawPath: "/sync/versions", queryStringParameters: {} };
  normalizeFcEvent(event as any);
  assert.equal((event as any).rawQueryString, undefined);
});

test("normalizeFcEvent: backfills rawQueryString from queryParameters (FC 3.0)", () => {
  const event = {
    rawPath: "/v1/sync/actor-directory",
    queryStringParameters: {},
    queryParameters: { teamId: "t1", since: "2026-05-01T00:00:00Z" },
  };
  normalizeFcEvent(event as any);
  const params = new URLSearchParams((event as any).rawQueryString);
  assert.equal(params.get("teamId"), "t1");
  assert.equal(params.get("since"), "2026-05-01T00:00:00Z");
});

test("normalizeFcEvent: prefers queryParameters when queryStringParameters is empty", () => {
  const event = {
    rawPath: "/v1/sync/actor-directory",
    queryParameters: { teamId: "fc3-team" },
  };
  normalizeFcEvent(event as any);
  assert.equal(new URLSearchParams((event as any).rawQueryString).get("teamId"), "fc3-team");
});

test("handler forwards FC 3.0 queryParameters to GET /v1/sync/actor-directory", async () => {
  const res: any = await handler(
    {
      rawPath: "/v1/sync/actor-directory",
      requestContext: { http: { method: "GET" } },
      headers: { authorization: "Bearer not-a-real-jwt" },
      queryStringParameters: {},
      queryParameters: { teamId: "fc3-handler-team" },
      body: "",
      isBase64Encoded: false,
    },
    {},
  );
  const body = JSON.parse(res.body);
  assert.notEqual(
    body?.error?.message,
    "teamId is required",
    "queryParameters were not backfilled into rawQueryString for Hono",
  );
});

test("hono/aws-lambda base64-encodes binary (png) round-trip", async () => {
  const app = new Hono();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  app.get("/f", () => new Response(png, { headers: { "Content-Type": "image/png" } }));
  const res: any = await handle(app)(
    {
      rawPath: "/f",
      requestContext: { http: { method: "GET" } },
      headers: {},
      isBase64Encoded: false,
      queryStringParameters: {},
    } as any,
    {} as any,
  );
  assert.equal(res.isBase64Encoded, true);
  assert.deepEqual(Buffer.from(res.body, "base64"), png);
});
