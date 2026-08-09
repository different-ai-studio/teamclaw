import { beforeEach, describe, expect, it, vi } from "vitest";

// The real module falls through to a `window`-backed web shim under the node
// test environment. Nothing here is testing persistence, only the wire shape.
vi.mock("@react-native-async-storage/async-storage", () => {
  const memory = new Map<string, string>();
  return {
    default: {
      getItem: async (key: string) => memory.get(key) ?? null,
      setItem: async (key: string, value: string) => void memory.set(key, value),
      removeItem: async (key: string) => void memory.delete(key),
    },
  };
});

/**
 * `/v1/auth/refresh` is the one `/v1/auth/*` endpoint FC maps instead of
 * forwarding a raw GoTrue body, so it answers in camelCase. Reading it as
 * snake_case made `setRefreshSession` throw "Authentication response did not
 * include a session." — and because `loadBootstrap` calls it immediately after
 * team activation, that broke startup for every user who had a team, with no
 * way out of the error screen.
 *
 * These pin the shape so the two sides cannot drift apart again silently.
 */

const CAMEL_CASE_REFRESH_RESPONSE = {
  accessToken: "new-access-token",
  refreshToken: "new-refresh-token",
  expiresAt: 1893456000,
};

function mockFetchOnce(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 401,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe("setRefreshSession", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("EXPO_PUBLIC_CLOUD_API_URL", "https://api.example.test");
  });

  it("accepts the camelCase body FC actually returns", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(CAMEL_CASE_REFRESH_RESPONSE));
    const { cloudAuth } = await import("../lib/auth/cloud-auth");

    const result = await cloudAuth.auth.setRefreshSession("old-refresh-token");

    expect(result.error).toBeNull();
    const { data } = await cloudAuth.auth.getSession();
    expect(data.session?.access_token).toBe("new-access-token");
    expect(data.session?.refresh_token).toBe("new-refresh-token");
  });

  it("sends the token under the key the route reads", async () => {
    const fetchMock = mockFetchOnce(CAMEL_CASE_REFRESH_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const { cloudAuth } = await import("../lib/auth/cloud-auth");

    await cloudAuth.auth.setRefreshSession("old-refresh-token");

    // FC: `const { refreshToken } = ctx.json` — snake_case here would 400.
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, { body: string }];
    expect(url).toContain("/v1/auth/refresh");
    expect(JSON.parse(init.body)).toEqual({ refreshToken: "old-refresh-token" });
  });

  /**
   * `loadBootstrap` calls this in the middle of a bootstrap, right after team
   * activation. The app's `onAuthStateChange` listener re-runs `bootstrap()`,
   * so notifying here re-entered bootstrap, and the new run's
   * `beginOperation()` invalidated the in-flight one — whose `bootstrapResolved`
   * then dropped on the floor. The result was an infinite loop stuck on
   * "Opening TeamClaw", hammering /v1/teams + activate + refresh each pass.
   *
   * Swapping tokens is not an auth-state change: same user, new claims.
   */
  it("does not wake auth-state subscribers, which would re-enter bootstrap", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(CAMEL_CASE_REFRESH_RESPONSE));
    const { cloudAuth } = await import("../lib/auth/cloud-auth");
    const onAuthStateChange = vi.fn();
    cloudAuth.auth.onAuthStateChange(onAuthStateChange);

    await cloudAuth.auth.setRefreshSession("old-refresh-token");

    expect(onAuthStateChange).not.toHaveBeenCalled();
    // ...and the swap still took effect.
    const { data } = await cloudAuth.auth.getSession();
    expect(data.session?.access_token).toBe("new-access-token");
  });

  it("reports a body with no tokens as an error rather than storing a blank session", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({}));
    const { cloudAuth } = await import("../lib/auth/cloud-auth");

    const result = await cloudAuth.auth.setRefreshSession("old-refresh-token");

    expect(result.error?.message).toMatch(/did not include a session/i);
  });
});
