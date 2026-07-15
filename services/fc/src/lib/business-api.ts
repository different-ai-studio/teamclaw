import { createApp } from "../app.js";
import { queryParams } from "./routing-utils.js";

// Canonical header casing for the FC response object. The Hono Response uses a
// Headers instance which lowercases keys; the legacy /v1 dispatch (and the FC
// HTTP trigger consumers + tests) expect these exact-case keys.
const HEADER_CANONICAL: Record<string, string> = {
  "content-type": "Content-Type",
  "x-request-id": "X-Request-Id",
  location: "Location",
};

// Content-Types that are NOT base64-encoded when returned to FC (everything
// else — e.g. image/*, application/octet-stream — is treated as binary and
// base64-encoded, mirroring the old business-api binary branch).
function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  return /^text\/(?:plain|html|css|javascript|csv)|(?:\/|\+)(?:json|xml)\s*(?:;|$)/.test(contentType);
}

/**
 * Bridge the synthetic FC `{ httpMethod, path, headers, body, ... }` events used
 * by the test suite into the canonical Hono app via `app.fetch`. This routes the
 * 9 /v1 test files through the SAME app that production serves, making their
 * assertions the equivalence proof for the migration.
 */
export async function handleBusinessApiRequest(event: any, deps: any): Promise<any> {
  const app = createApp(deps);

  const method: string = event.httpMethod || event.requestContext?.http?.method || "GET";
  const rawPath: string = event.path || event.rawPath || "/";
  const pathname = rawPath.split("?")[0];

  // Build the URL with query params (reuse the canonical query parser so that
  // queryStringParameters / queryParameters / rawQueryString all flow through).
  const params = queryParams(event);
  const search = params.toString();
  const url = `https://fc.local${pathname.startsWith("/") ? pathname : `/${pathname}`}${search ? `?${search}` : ""}`;

  // Headers.
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers || {})) {
    if (v !== undefined && v !== null) headers.set(k, String(v));
  }

  // Body, decoded per isBase64Encoded.
  let body: Buffer | string | undefined;
  if (method !== "GET" && method !== "HEAD" && event.body !== undefined && event.body !== null && event.body !== "") {
    body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  }

  const res = await app.fetch(new Request(url, { method, headers, body }));

  // Map the Response back to the FC result shape with canonical header casing.
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    outHeaders[HEADER_CANONICAL[key] ?? key] = value;
  });

  const contentType = res.headers.get("content-type");
  if (res.status === 302 && res.headers.has("location")) {
    return { statusCode: 302, headers: outHeaders, body: "" };
  }
  if (!isTextContentType(contentType)) {
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      statusCode: res.status,
      headers: outHeaders,
      body: bytes.toString("base64"),
      isBase64Encoded: true,
    };
  }
  return {
    statusCode: res.status,
    headers: outHeaders,
    body: await res.text(),
    isBase64Encoded: false,
  };
}

export { encodeCursor, decodeCursor } from "./routing-utils.js";
