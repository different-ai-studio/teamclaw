import { ApiError } from "./http-utils.js";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return {
      lastMessageAt: optionalStringOrNull(parsed.lastMessageAt, "cursor.lastMessageAt"),
      createdAt: optionalStringOrNull(parsed.createdAt, "cursor.createdAt"),
      id: optionalStringOrNull(parsed.id, "cursor.id"),
    };
  } catch (cause) {
    throw new ApiError(400, "validation_failed", "Invalid cursor", { cause });
  }
}

export function nextSessionCursor(items, limit) {
  if (!Array.isArray(items) || items.length < limit) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return encodeCursor({
    lastMessageAt: last.lastMessageAt ?? null,
    createdAt: last.createdAt ?? null,
    id: last.id,
  });
}

export function parseLimit(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_LIST_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ApiError(400, "validation_failed", "limit must be an integer from 1 to 100");
  }
  return limit;
}

export function queryParams(event) {
  const params = new URLSearchParams();
  // FC 2.0 uses queryStringParameters; FC 3.0 uses queryParameters. Some events
  // carry an empty queryStringParameters object alongside populated queryParameters.
  for (const source of [event.queryStringParameters, event.queryParameters]) {
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
  }
  let raw = event.rawQueryString ?? event.queryString ?? "";
  if (!raw) {
    const pathStr = event.rawPath ?? event.path ?? "";
    const qIdx = pathStr.indexOf("?");
    if (qIdx >= 0) raw = pathStr.slice(qIdx + 1);
  }
  if (raw) {
    for (const [key, value] of new URLSearchParams(raw)) {
      params.set(key, value);
    }
  }
  return params;
}

export function normalizePath(path) {
  const withoutQuery = path.split("?")[0];
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

export function requireString(value, field) {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new ApiError(400, "validation_failed", `${field} is required`);
}

export function optionalStringOrNull(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new ApiError(400, "validation_failed", `${field} must be a string or null`);
}
