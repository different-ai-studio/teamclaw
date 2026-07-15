import { randomUUID } from "node:crypto";

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export class ApiError extends Error {
  statusCode: any;
  code: any;
  details: any;
  declare cause: any;
  constructor(statusCode, code, message, options: any = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;
    normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
}

export function getHeader(headers, name) {
  return normalizeHeaders(headers)[name.toLowerCase()];
}

export function resolveRequestId(headers = {}, makeId = randomUUID) {
  const incoming = getHeader(headers, "x-request-id");
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming;
  return makeId().replaceAll("-", "").slice(0, 32);
}

export function extractBearerToken(headers = {}) {
  const authorization = getHeader(headers, "authorization");
  if (!authorization) {
    throw new ApiError(401, "missing_auth", "Missing Authorization bearer token");
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]?.trim()) {
    throw new ApiError(401, "missing_auth", "Invalid Authorization bearer token");
  }

  return match[1].trim();
}

// Like extractBearerToken but returns null instead of throwing when the
// Authorization header is absent. Used by routes where a bearer is optional
// (e.g. native id_token sign-in: present only for the identity-link path).
export function optionalBearerToken(headers = {}) {
  const authorization = getHeader(headers, "authorization");
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match && match[1]?.trim() ? match[1].trim() : null;
}

export function decodeBody(event: any = {}) {
  if (event.body === undefined || event.body === null || event.body === "") return "";
  if (event.isBase64Encoded) return Buffer.from(event.body, "base64").toString("utf8");
  return String(event.body);
}

export function parseJsonBody(event: any = {}) {
  const raw = decodeBody(event);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON", { cause });
  }
}

export function jsonResponse(statusCode, body, requestId, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export function errorResponse(error, requestId) {
  const normalized = normalizeError(error);
  const body: any = {
    code: normalized.code,
    message: normalized.message,
    requestId,
  };
  // Surface structured details (e.g. the underlying db/PostgREST code) when we
  // have them so the client/operator can diagnose without grepping FC logs.
  if (normalized.details !== undefined) body.details = normalized.details;
  return jsonResponse(normalized.statusCode, { error: body }, requestId);
}

export function normalizeError(error) {
  if (error instanceof ApiError) return error;

  const mapped = mapSupabaseError(error);
  if (mapped) return mapped;

  // Log unclassified errors so they're diagnosable in FC logs instead of
  // silently surfacing as opaque "internal" 500s.
  try { console.error("[business-api] unclassified error:", error?.message, error?.name, error?.stack?.split("\n").slice(0,5).join(" | ")); } catch {}

  // Surface the real cause instead of an opaque "Internal server error". These
  // are TeamClaw's own clients hitting our Cloud API; swallowing the message
  // forced a round-trip through FC logs on every incident. Keep status 500 but
  // make the body self-describing: include the underlying message and any
  // db/PostgREST code (e.g. PGRST202 = function/schema-cache miss).
  const rawMessage = typeof error?.message === "string" ? error.message.trim() : "";
  const upstreamCode = error?.code || error?.details?.code || null;
  return new ApiError(500, "internal", rawMessage || "Internal server error", {
    cause: error,
    details: upstreamCode ? { upstreamCode } : undefined,
  });
}

export function mapSupabaseError(error) {
  const pgCode = error?.code || error?.details?.code;
  const httpStatus = Number(error?.status || error?.statusCode || error?.httpStatus);
  const message = error?.message || "Supabase request failed";

  // PostgREST-level errors carry a string `code` like "PGRST202" plus a
  // descriptive `message`, but NO numeric HTTP status — so the httpStatus
  // branches below never catch them and they used to fall through to an opaque
  // 500 with the cause hidden in FC logs. Classify them explicitly.
  if (typeof pgCode === "string" && pgCode.startsWith("PGRST")) {
    // PGRST116: no rows where one was required → genuine not-found.
    if (pgCode === "PGRST116") {
      return new ApiError(404, "not_found", message, { cause: error });
    }
    // PGRST3xx is the JWT / authentication error group: PGRST300 (JWSError /
    // misconfigured secret), PGRST301 ("JWT expired" / invalid token),
    // PGRST302 (anonymous access disabled). PostgREST returns these as HTTP
    // 401, but supabase-js surfaces them with only the `code` (no numeric
    // status), so they used to fall through to the schema_drift catch-all
    // below and surface as an opaque 500. That hid token expiry from clients
    // and — critically — stopped the daemon from refreshing the token, since
    // it keys re-auth off the 401 status. Classify them as 401 so the cause is
    // visible and clients can refresh.
    if (/^PGRST3\d\d$/.test(pgCode)) {
      return new ApiError(401, "unauthorized", message, {
        cause: error,
        details: { upstreamCode: pgCode },
      });
    }
    // PGRST202 (function not found in schema cache), PGRST203 (ambiguous
    // overload), PGRST204 (column not found), etc. almost always mean
    // server-side schema drift / a missing migration. Surface the cause and
    // the code so it is diagnosable straight from the API response.
    return new ApiError(500, "schema_drift", message, {
      cause: error,
      details: { upstreamCode: pgCode },
    });
  }

  if (pgCode === "42501" || httpStatus === 403) {
    return new ApiError(403, "forbidden", message, { cause: error });
  }
  if (pgCode === "23505") {
    return new ApiError(409, "conflict", message, { cause: error });
  }
  if (pgCode === "23514" || pgCode === "22P02" || httpStatus === 400) {
    return new ApiError(400, "validation_failed", message, { cause: error });
  }
  // 23502 not_null_violation: a required column was omitted (e.g. team_id).
  // 42P10 invalid_column_reference: an ON CONFLICT target with no matching
  // unique constraint. Both signal a bad request / server-side drift rather
  // than an opaque internal error — map them to 400 so the cause is visible.
  if (pgCode === "23502" || pgCode === "42P10") {
    return new ApiError(400, "bad_request", message, { cause: error });
  }
  if (httpStatus === 404) {
    return new ApiError(404, "not_found", message, { cause: error });
  }
  if (httpStatus === 401) {
    return new ApiError(401, "missing_auth", message, { cause: error });
  }
  if (httpStatus === 429) {
    return new ApiError(429, "rate_limited", message, { cause: error });
  }
  if (httpStatus >= 500 || error?.isSupabaseError) {
    return new ApiError(502, "upstream_unavailable", message, { cause: error });
  }

  return null;
}
