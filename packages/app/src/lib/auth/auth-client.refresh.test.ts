import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "./auth-client";
import { __resetSessionStoreForTests, adoptRefreshToken, getSession, setSession } from "./session-store";

beforeEach(() => __resetSessionStoreForTests());

// Build a syntactically valid JWT whose payload carries the identity claims a
// GoTrue access token would. Only the payload is decoded client-side.
function b64url(obj: unknown): string {
  const json = JSON.stringify(obj);
  const b64 = typeof btoa === "function" ? btoa(json) : Buffer.from(json, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

describe("auth-client refresh — establishing a session from a refresh-only response", () => {
  // Repro of the web-SSO bug: adoptSession refreshes a harvested token while NOT
  // logged in (current session is null). The FC /v1/auth/refresh response is
  // camelCase and carries no user, so the session must be reconstructed with the
  // user derived from the access-token JWT — otherwise AuthGate sees no user and
  // bounces back to the login screen.
  it("adopts a camelCase refresh response into a full snake_case session with a JWT-derived user", async () => {
    const jwt = makeJwt({ sub: "user-123", email: "x@y.z", is_anonymous: false });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ accessToken: jwt, refreshToken: "rt2", expiresAt: 999 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    // createAuthClient wires the refresher into the session store.
    createAuthClient({ baseUrl: "https://cloud.ucar.cc", fetchImpl });

    const out = await adoptRefreshToken("rt-in");

    expect(out.access_token).toBe(jwt);
    expect(out.refresh_token).toBe("rt2");
    expect(out.expires_at).toBe(999);
    expect(out.user?.id).toBe("user-123");
    expect(out.user?.email).toBe("x@y.z");
    // The installed (persisted) session must be the snake_case one, not the raw row.
    expect(getSession()?.access_token).toBe(jwt);
    expect(getSession()?.user?.id).toBe("user-123");
  });

  it("preserves the live session's user when refreshing (does not let the JWT override it)", async () => {
    // The refresh JWT carries a different sub; the existing user must win so a
    // routine refresh never silently swaps identity.
    const jwt = makeJwt({ sub: "jwt-sub-should-not-win", email: "live@y.z" });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ accessToken: jwt, refreshToken: "rt3", expiresAt: 1000 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    createAuthClient({ baseUrl: "https://cloud.ucar.cc", fetchImpl });
    // Seed a live session (as if already signed in).
    setSession(
      {
        access_token: "old-at",
        refresh_token: "rt-old",
        expires_at: 1,
        token_type: "bearer",
        user: { id: "existing-1", email: "e@x.z" },
      },
      "SIGNED_IN",
    );
    const out = await adoptRefreshToken("rt-old");
    expect(out.user?.id).toBe("existing-1");
    expect(out.access_token).toBe(jwt);
    expect(out.refresh_token).toBe("rt3");
  });
});
