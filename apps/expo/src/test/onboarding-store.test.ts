import { describe, expect, it, vi } from "vitest";

import type {
  BootstrapResult,
  OnboardingState,
} from "../features/onboarding/onboarding-types";
type OnboardingApi = ReturnType<
  (typeof import("../lib/supabase/onboarding-api"))["createOnboardingApi"]
>;

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createApiMock(overrides: Partial<OnboardingApi> = {}): OnboardingApi {
  return {
    getCurrentSession: vi.fn().mockResolvedValue(null),
    loadBootstrap: vi.fn().mockResolvedValue({
      isAnonymous: false,
      team: null,
      memberActorId: null,
    } satisfies BootstrapResult),
    signInAnonymously: vi.fn().mockResolvedValue({}),
    sendEmailOTP: vi.fn().mockImplementation(async (email: string) => ({
      pendingEmail: email,
    })),
    verifyOTP: vi.fn().mockResolvedValue({}),
    createOAuthSignInUrl: vi.fn().mockResolvedValue("https://auth.example.com/oauth"),
    createOAuthLinkUrl: vi.fn().mockResolvedValue("https://auth.example.com/link"),
    completeOAuthCallback: vi.fn().mockResolvedValue({}),
    createTeam: vi.fn().mockResolvedValue({
      id: "team-created",
      name: "Created Team",
      slug: "created-team",
      role: "owner",
    }),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function loadController() {
  return import("../features/onboarding/onboarding-store");
}

describe("createOnboardingController", () => {
  it("bootstrap routes to needsAuth when there is no current session", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue(null),
    });

    const controller = createOnboardingController(api);

    await controller.bootstrap();

    expect(api.getCurrentSession).toHaveBeenCalledTimes(1);
    expect(api.loadBootstrap).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "needsAuth",
      isBusy: false,
      errorMessage: null,
      pendingEmailOTPEmail: null,
    });
  });

  it("bootstrap stores team context and becomes ready when bootstrap data has a team", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: {
          id: "team-1",
          name: "Team Claw",
          slug: "team-claw",
          role: "owner",
        },
        memberActorId: "member-1",
      } satisfies BootstrapResult),
    });

    const controller = createOnboardingController(api);

    await controller.bootstrap();

    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "ready",
      currentTeam: {
        id: "team-1",
        name: "Team Claw",
        slug: "team-claw",
        role: "owner",
      },
      currentMemberActorId: "member-1",
      isAnonymous: false,
    });
  });

  it("bootstrap rejects on failure and stores the safe failed state", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      loadBootstrap: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const controller = createOnboardingController(api);

    await expect(controller.bootstrap()).rejects.toThrow("boom");
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "failed",
      isBusy: false,
      errorMessage: "We couldn't load your account right now. Please try again.",
      currentTeam: null,
      currentMemberActorId: null,
    });
  });

  it("requestOtp stores the returned pending email", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      sendEmailOTP: vi.fn().mockResolvedValue({
        pendingEmail: "normalized@example.com",
      }),
    });
    const controller = createOnboardingController(api);

    await controller.requestOtp("person@example.com");

    expect(api.sendEmailOTP).toHaveBeenCalledWith("person@example.com");
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      pendingEmailOTPEmail: "normalized@example.com",
      isBusy: false,
      errorMessage: null,
    });
  });

  it("verifyOtp requires a pending email before verifying", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock();
    const controller = createOnboardingController(api);

    await expect(controller.verifyOtp("123456")).rejects.toThrow(
      "No pending email OTP request",
    );
    expect(api.verifyOTP).not.toHaveBeenCalled();
  });

  it("verifyOtp uses the stored email and then bootstraps", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: null,
        memberActorId: null,
      } satisfies BootstrapResult),
    });
    const controller = createOnboardingController(api);

    await controller.requestOtp("person@example.com");
    await controller.verifyOtp("123456");

    expect(api.verifyOTP).toHaveBeenCalledWith("person@example.com", "123456");
    expect(api.loadBootstrap).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "createTeam",
      pendingEmailOTPEmail: null,
    });
  });

  it("signInWithOAuth opens the browser session, completes the callback, and bootstraps", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: {
          id: "team-1",
          name: "Team Claw",
          slug: "team-claw",
          role: "owner",
        },
        memberActorId: "member-1",
      } satisfies BootstrapResult),
    });
    const openAuthSession = vi
      .fn()
      .mockResolvedValue({ type: "success", url: "teamclaw://auth/callback?code=abc" });
    const controller = createOnboardingController(api);

    await controller.signInWithOAuth("google", {
      redirectTo: "teamclaw://auth/callback",
      openAuthSession,
    });

    expect(api.createOAuthSignInUrl).toHaveBeenCalledWith(
      "google",
      "teamclaw://auth/callback",
    );
    expect(openAuthSession).toHaveBeenCalledWith(
      "https://auth.example.com/oauth",
      "teamclaw://auth/callback",
    );
    expect(api.completeOAuthCallback).toHaveBeenCalledWith(
      "teamclaw://auth/callback?code=abc",
    );
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "ready",
      currentMemberActorId: "member-1",
      isBusy: false,
    });
  });

  it("signInWithOAuth clears busy state when the browser auth session is cancelled", async () => {
    const { createOnboardingController } = await loadController();
    const openAuthSession = vi.fn().mockResolvedValue({ type: "cancel" });
    const api = createApiMock();
    const controller = createOnboardingController(api);

    await controller.signInWithOAuth("apple", {
      redirectTo: "teamclaw://auth/callback",
      openAuthSession,
    });

    expect(api.completeOAuthCallback).not.toHaveBeenCalled();
    expect(api.loadBootstrap).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      isBusy: false,
      errorMessage: null,
    });
  });

  it("linkIdentityWithOAuth links an identity, completes callback, and bootstraps", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: {
          id: "team-1",
          name: "Team Claw",
          slug: "team-claw",
          role: "owner",
        },
        memberActorId: "member-1",
      } satisfies BootstrapResult),
    });
    const openAuthSession = vi
      .fn()
      .mockResolvedValue({ type: "success", url: "teamclaw://auth/callback?code=abc" });
    const controller = createOnboardingController(api);

    await controller.linkIdentityWithOAuth("apple", {
      redirectTo: "teamclaw://auth/callback",
      openAuthSession,
    });

    expect(api.createOAuthLinkUrl).toHaveBeenCalledWith(
      "apple",
      "teamclaw://auth/callback",
    );
    expect(openAuthSession).toHaveBeenCalledWith(
      "https://auth.example.com/link",
      "teamclaw://auth/callback",
    );
    expect(api.completeOAuthCallback).toHaveBeenCalledWith(
      "teamclaw://auth/callback?code=abc",
    );
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "ready",
      isAnonymous: false,
      isBusy: false,
    });
  });

  it("signOut after ready returns to needsAuth and calls the API", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: {
          id: "team-1",
          name: "Team Claw",
          slug: "team-claw",
          role: "owner",
        },
        memberActorId: "member-1",
      } satisfies BootstrapResult),
    });
    const controller = createOnboardingController(api);
    await controller.bootstrap();

    await controller.signOut();

    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "needsAuth",
      currentTeam: null,
      currentMemberActorId: null,
      isAnonymous: false,
    });
  });

  it("ignores a stale signOut completion after a newer requestOtp", async () => {
    const { createOnboardingController } = await loadController();
    const deferredSignOut = createDeferredPromise<void>();
    const api = createApiMock({
      signOut: vi.fn().mockImplementation(() => deferredSignOut.promise),
      sendEmailOTP: vi.fn().mockResolvedValue({
        pendingEmail: "normalized@example.com",
      }),
    });
    const controller = createOnboardingController(api);

    const signOutPromise = controller.signOut();
    await Promise.resolve();
    await controller.requestOtp("person@example.com");
    deferredSignOut.resolve(undefined);
    await signOutPromise;

    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "loading",
      pendingEmailOTPEmail: "normalized@example.com",
      isBusy: false,
      errorMessage: null,
    });
  });

  it("ignores a stale bootstrap completion after signOut", async () => {
    const { createOnboardingController } = await loadController();
    const deferredBootstrap = createDeferredPromise<BootstrapResult>();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      loadBootstrap: vi.fn().mockImplementation(() => deferredBootstrap.promise),
    });
    const controller = createOnboardingController(api);

    const bootstrapPromise = controller.bootstrap();
    await Promise.resolve();
    await controller.signOut();
    deferredBootstrap.resolve({
      isAnonymous: false,
      team: {
        id: "team-stale",
        name: "Stale Team",
        slug: "stale-team",
        role: "owner",
      },
      memberActorId: "member-stale",
    });
    await bootstrapPromise;

    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "needsAuth",
      currentTeam: null,
      currentMemberActorId: null,
      pendingEmailOTPEmail: null,
      isBusy: false,
    });
  });

  it("createTeam calls the API and re-runs bootstrap into ready state", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: {
          id: "team-2",
          name: "Launch Team",
          slug: "launch-team",
          role: "owner",
        },
        memberActorId: "member-2",
      } satisfies BootstrapResult),
    });
    const controller = createOnboardingController(api);

    await controller.createTeam("Launch Team");

    expect(api.createTeam).toHaveBeenCalledWith("Launch Team");
    expect(api.loadBootstrap).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "ready",
      currentTeam: {
        id: "team-2",
        name: "Launch Team",
        slug: "launch-team",
        role: "owner",
      },
      currentMemberActorId: "member-2",
      isAnonymous: false,
    });
  });

  it("createTeam rejects on bootstrap failure and preserves the safe bootstrap failure state", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockRejectedValue(new Error("raw bootstrap boom")),
    });
    const controller = createOnboardingController(api);

    await expect(controller.createTeam("Launch Team")).rejects.toThrow(
      "raw bootstrap boom",
    );

    expect(api.createTeam).toHaveBeenCalledWith("Launch Team");
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "failed",
      isBusy: false,
      errorMessage: "We couldn't load your account right now. Please try again.",
      currentTeam: null,
      currentMemberActorId: null,
    });
  });

  it("notifies subscribers when state changes", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock();
    const controller = createOnboardingController(api);
    const listener = vi.fn();

    const unsubscribe = controller.subscribe(listener);
    await controller.requestOtp("person@example.com");
    unsubscribe();
    await controller.requestOtp("other@example.com");

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
