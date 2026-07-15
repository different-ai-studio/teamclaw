import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  errorResponse,
  extractBearerToken,
  mapSupabaseError,
  normalizeError,
  parseJsonBody,
  resolveRequestId,
} from "../src/lib/http-utils.js";

test("resolveRequestId reuses only log-safe request ids", () => {
  assert.equal(resolveRequestId({ "X-Request-Id": "abcDEF_123-xyz" }), "abcDEF_123-xyz");
  assert.equal(resolveRequestId({ "X-Request-Id": "../bad" }, () => "generated-id-123" as any), "generatedid123");
  assert.equal(resolveRequestId({}, () => "01234567-89ab-cdef-0123-456789abcdef"), "0123456789abcdef0123456789abcdef");
});

test("extractBearerToken accepts case-insensitive bearer headers", () => {
  assert.equal(extractBearerToken({ authorization: "Bearer token-1" }), "token-1");
  assert.equal(extractBearerToken({ Authorization: "bearer token-2 " }), "token-2");
});

test("extractBearerToken rejects missing or malformed authorization", () => {
  assert.throws(() => extractBearerToken({}), /Missing Authorization/);
  assert.throws(() => extractBearerToken({ authorization: "Basic abc" }), /Invalid Authorization/);
});

test("parseJsonBody decodes plain and base64 json bodies", () => {
  assert.deepEqual(parseJsonBody({ body: '{"a":1}' }), { a: 1 });
  assert.deepEqual(
    parseJsonBody({ body: Buffer.from('{"b":2}').toString("base64"), isBase64Encoded: true }),
    { b: 2 },
  );
  assert.deepEqual(parseJsonBody({}), {});
});

test("parseJsonBody returns invalid_json for malformed bodies", () => {
  assert.throws(() => parseJsonBody({ body: "{" }), (err: any) => {
    assert.equal(err.code, "invalid_json");
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test("mapSupabaseError keeps business errors client-actionable", () => {
  assert.deepEqual(
    pick(mapSupabaseError({ code: "42501", message: "rls denied" })),
    { statusCode: 403, code: "forbidden", message: "rls denied" },
  );
  assert.deepEqual(
    pick(mapSupabaseError({ code: "23505", message: "duplicate key" })),
    { statusCode: 409, code: "conflict", message: "duplicate key" },
  );
  assert.deepEqual(
    pick(mapSupabaseError({ code: "23514", message: "check failed" })),
    { statusCode: 400, code: "validation_failed", message: "check failed" },
  );
  assert.deepEqual(
    pick(mapSupabaseError({ status: 404, message: "missing row" })),
    { statusCode: 404, code: "not_found", message: "missing row" },
  );
});

test("errorResponse emits stable envelope and request header", () => {
  const response = errorResponse(new ApiError(409, "conflict", "Already exists"), "req_12345678");
  assert.equal(response.statusCode, 409);
  assert.equal(response.headers["X-Request-Id"], "req_12345678");
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "conflict",
      message: "Already exists",
      requestId: "req_12345678",
    },
  });
});

test("mapSupabaseError classifies PostgREST schema-cache errors with the cause", () => {
  // The create_team 500 regression: a missing migration meant PostgREST could
  // not resolve the function signature. supabase-js throws a PostgrestError
  // with code "PGRST202" and NO numeric status, which used to fall through to
  // an opaque 500. It must now surface as a diagnosable schema_drift.
  const mapped = mapSupabaseError({
    code: "PGRST202",
    message: "Could not find the function public.create_team(...) in the schema cache",
  });
  assert.equal(mapped.statusCode, 500);
  assert.equal(mapped.code, "schema_drift");
  assert.match(mapped.message, /schema cache/);
  assert.deepEqual(mapped.details, { upstreamCode: "PGRST202" });
});

test("mapSupabaseError maps PGRST116 (no rows) to not_found", () => {
  const mapped = mapSupabaseError({ code: "PGRST116", message: "no rows" });
  assert.equal(mapped.statusCode, 404);
  assert.equal(mapped.code, "not_found");
});

test("mapSupabaseError maps PGRST3xx (JWT/auth) to 401, not schema_drift", () => {
  // An expired bearer token makes PostgREST return code "PGRST301" with
  // message "JWT expired" and NO numeric status. It must surface as a 401 so
  // the daemon's re-auth path (which keys off the 401 status) refreshes the
  // token, instead of an opaque schema_drift 500 dead-end.
  const expired = mapSupabaseError({ code: "PGRST301", message: "JWT expired" });
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.code, "unauthorized");
  assert.equal(expired.message, "JWT expired");
  assert.deepEqual(expired.details, { upstreamCode: "PGRST301" });

  // Whole PGRST3xx group is auth-class (PGRST300 JWSError, PGRST302 anon
  // disabled), all 401.
  assert.equal(mapSupabaseError({ code: "PGRST302", message: "anon disabled" }).statusCode, 401);

  // Guard the boundary: PGRST2xx schema-cache codes stay schema_drift 500.
  assert.equal(mapSupabaseError({ code: "PGRST202", message: "missing fn" }).code, "schema_drift");
});

test("normalizeError surfaces the real message instead of opaque 'Internal server error'", () => {
  // A plain Error that no classifier recognises must still reach the client
  // with its real message + any upstream code, not a generic 500 body that
  // forces a trip through FC logs.
  const err = Object.assign(new Error("boom: relation \"widgets\" does not exist"), { code: "42P01" });
  const normalized = normalizeError(err);
  assert.equal(normalized.statusCode, 500);
  assert.equal(normalized.code, "internal");
  assert.equal(normalized.message, 'boom: relation "widgets" does not exist');
  assert.deepEqual(normalized.details, { upstreamCode: "42P01" });
});

test("errorResponse includes details in the body when present", () => {
  const response = errorResponse({ code: "PGRST202", message: "missing fn in schema cache" }, "req_abcdef12");
  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "schema_drift",
      message: "missing fn in schema cache",
      requestId: "req_abcdef12",
      details: { upstreamCode: "PGRST202" },
    },
  });
});

function pick(error) {
  return {
    statusCode: error.statusCode,
    code: error.code,
    message: error.message,
  };
}
