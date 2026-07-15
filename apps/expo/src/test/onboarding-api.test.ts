import { describe, expect, it, vi } from "vitest";

import type { BootstrapResult, TeamSummary } from "../features/onboarding/onboarding-types";

function makeClient(overrides: {
  session?: { user: { id: string; is_anonymous?: boolean; email?: string | null } } | null;
  get?: ReturnType<typeof vi.fn>;
  post?: ReturnType<typeof vi.fn>;
  auth?: Record<string, unknown>;
}) {
  const session = overrides.session === undefined ? null : overrides.session;
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session } }),
      ...overrides.auth,
    },
    api: {
      get: overrides.get ?? vi.fn(),
      post: overrides.post ?? vi.fn(),
    },
  } as never;
}

describe("createOnboardingApi (cloud-only)", () => {
  it("loadBootstrap returns null team when the session is anonymous with no teams", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const get = vi.fn().mockResolvedValue({ memberActorId: null, teams: [], memberActorIdByTeam: {} });
    const client = makeClient({
      session: { user: { id: "user-1", is_anonymous: true } },
      get,
    });

    const api = createOnboardingApi(client);
    await expect(api.loadBootstrap()).resolves.toEqual({
      isAnonymous: true,
      team: null,
      memberActorId: null,
    } satisfies BootstrapResult);
    expect(get).toHaveBeenCalledWith("/v1/me/bootstrap");
  });

  it("loadBootstrap maps the first bootstrap team + member actor id", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const get = vi.fn().mockResolvedValue({
      memberActorId: "actor-1",
      teams: [
        { id: "team-1", name: "Team Claw", slug: "team-claw", role: "owner" },
        { id: "team-2", name: "Ignored", slug: "ignored", role: "member" },
      ],
      memberActorIdByTeam: { "team-1": "actor-1", "team-2": "actor-2" },
    });
    const client = makeClient({ session: { user: { id: "user-1", is_anonymous: false } }, get });

    const api = createOnboardingApi(client);
    await expect(api.loadBootstrap()).resolves.toEqual({
      isAnonymous: false,
      memberActorId: "actor-1",
      team: { id: "team-1", name: "Team Claw", slug: "team-claw", role: "owner" } satisfies TeamSummary,
    } satisfies BootstrapResult);
  });

  it("loadBootstrap returns empty when there is no session", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const client = makeClient({ session: null });
    const api = createOnboardingApi(client);
    await expect(api.loadBootstrap()).resolves.toEqual({
      isAnonymous: false,
      team: null,
      memberActorId: null,
    } satisfies BootstrapResult);
  });

  it("sendEmailOTP requests an OTP and returns the pending email", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const signInWithOtp = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ auth: { signInWithOtp } });
    const api = createOnboardingApi(client);

    await expect(api.sendEmailOTP("person@example.com")).resolves.toEqual({
      pendingEmail: "person@example.com",
    });
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      options: { shouldCreateUser: true },
    });
  });

  it("verifyOTP delegates to the auth client with email type", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const verifyOtp = vi.fn().mockResolvedValue({});
    const client = makeClient({ auth: { verifyOtp } });
    const api = createOnboardingApi(client);

    await api.verifyOTP("person@example.com", "123456");
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      token: "123456",
      type: "email",
    });
  });

  it("createOAuthSignInUrl builds the PKCE authorize URL", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const oauthAuthorize = vi
      .fn()
      .mockResolvedValue("https://fc.example.com/v1/auth/oauth/google/authorize?...");
    const client = makeClient({ auth: { oauthAuthorize } });
    const api = createOnboardingApi(client);

    await expect(
      api.createOAuthSignInUrl("google", "teamclaw://auth/callback"),
    ).resolves.toBe("https://fc.example.com/v1/auth/oauth/google/authorize?...");
    expect(oauthAuthorize).toHaveBeenCalledWith("google", "teamclaw://auth/callback");
  });

  it("completeOAuthCallback exchanges a PKCE code", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const exchangeOAuthCode = vi.fn().mockResolvedValue({});
    const client = makeClient({ auth: { exchangeOAuthCode } });
    const api = createOnboardingApi(client);

    await api.completeOAuthCallback("teamclaw://auth/callback?code=abc");
    expect(exchangeOAuthCode).toHaveBeenCalledWith("abc");
  });

  it("completeOAuthCallback stores implicit token callbacks", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const setSession = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client = makeClient({ auth: { setSession } });
    const api = createOnboardingApi(client);

    await api.completeOAuthCallback(
      "teamclaw://auth/callback#access_token=access&refresh_token=refresh",
    );
    expect(setSession).toHaveBeenCalledWith({
      access_token: "access",
      refresh_token: "refresh",
    });
  });

  it("createTeam posts to /v1/teams then resolves role from bootstrap", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const post = vi.fn().mockResolvedValue({ id: "team-1", name: "Team Claw", slug: "team-claw" });
    const get = vi.fn().mockResolvedValue({
      memberActorId: "actor-1",
      teams: [{ id: "team-1", name: "Team Claw", slug: "team-claw", role: "owner" }],
      memberActorIdByTeam: { "team-1": "actor-1" },
    });
    const client = makeClient({ post, get });
    const api = createOnboardingApi(client);

    await expect(api.createTeam("Team Claw")).resolves.toEqual({
      id: "team-1",
      name: "Team Claw",
      slug: "team-claw",
      role: "owner",
    } satisfies TeamSummary);
    expect(post).toHaveBeenCalledWith("/v1/teams", { name: "Team Claw" });
    expect(get).toHaveBeenCalledWith("/v1/me/bootstrap");
  });
});
