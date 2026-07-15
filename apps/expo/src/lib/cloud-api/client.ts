// Shared TeamClaw Cloud API HTTP client for Expo feature providers. Mirrors the
// transport that sessions/cloud-api.ts introduced, generalised with PATCH/DELETE
// so every feature decorator can reuse one implementation. Identity comes from
// the bearer token (getAccessToken); the FC facade derives the user server-side.

export type CloudApiClient = {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
  patch: <T>(path: string, body?: unknown) => Promise<T>;
  del: (path: string) => Promise<void>;
};

/** Thrown for non-2xx Cloud API responses; carries the HTTP status so callers
 * can branch (e.g. treat 404 as "absent" rather than an error). */
export class CloudApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
  }
}

/** Resolve the Cloud API base URL (cloud_api is the only client backend). */
export function cloudApiBaseUrl(): string {
  const baseUrl = process.env.EXPO_PUBLIC_CLOUD_API_URL?.trim();
  if (!baseUrl) {
    throw new Error("EXPO_PUBLIC_CLOUD_API_URL is required (cloud_api is the only backend).");
  }
  return baseUrl;
}

/** Build a getAccessToken closure from a Supabase client's auth session.
 * Transitional bridge until the auth layer itself moves off the SDK. */
export function supabaseAccessToken(
  client: { auth: { getSession: () => Promise<{ data: { session: { access_token: string } | null } }> } },
): () => Promise<string | null> {
  return async () => {
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  };
}

function createRequestId(): string {
  return `req_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function createCloudApiClient(args: {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): CloudApiClient {
  const baseUrl = args.baseUrl.replace(/\/+$/, "");
  const fetchImpl = args.fetchImpl ?? fetch;

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const token = await args.getAccessToken();
    if (!token) throw new Error("Missing auth session access token.");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-Request-Id": createRequestId(),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new CloudApiError(
        response.status,
        payload?.error?.message ?? "Cloud API request failed.",
      );
    }
    return payload as T;
  }

  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) =>
      request<T>("POST", path, body, options),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
    del: async (path: string) => {
      await request<unknown>("DELETE", path);
    },
  };
}
