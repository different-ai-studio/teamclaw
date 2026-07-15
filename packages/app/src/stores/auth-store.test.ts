import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/web-sso", () => ({
  runWebSso: vi.fn(),
  cancelWebSso: vi.fn(),
}));

import { runWebSso, cancelWebSso } from "@/lib/auth/web-sso";

const authMock = {
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
  sendPhoneOtp: vi.fn(),
  verifyPhoneOtpResult: vi.fn(),
  loginWithPhoneUser: vi.fn(),
  signOut: vi.fn(),
  signInAnonymously: vi.fn(),
  claimInvite: vi.fn(),
  sendUpgradeEmailOtp: vi.fn(),
  verifyUpgradeEmailOtp: vi.fn(),
  adoptSession: vi.fn(),
};
const backendMock = {
  auth: authMock,
};
const backendConfig = { hasConfig: true };
const session = {
  user: { id: "u1", email: "u1@example.com" },
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 12345,
};

const currentTeamMock = {
  reloadAndSwitchTo: vi.fn(),
};

function storeSessionLike(userId: string) {
  return {
    user: { id: userId, email: null },
    accessToken: `access-${userId}`,
    refreshToken: `refresh-${userId}`,
    expiresAt: 99999,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("@/lib/backend", () => ({
  getBackend: () => backendMock,
  hasBackendConfig: () => backendConfig.hasConfig,
  BACKEND_CONFIG_MISSING_MESSAGE: "Supabase config missing. Configure a server before signing in.",
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => currentTeamMock,
  },
}));

const { useAuthStore } = await import("./auth-store");

beforeEach(() => {
  Object.values(authMock).forEach((fn) => fn.mockReset());
  currentTeamMock.reloadAndSwitchTo.mockReset();
  backendConfig.hasConfig = true;
  useAuthStore.setState({
    session: null,
    loading: true,
    authFlow: "idle",
    errorMessage: null,
    otpEmail: null,
    otpPhone: null,
    pendingInviteToken: null,
  });
});

function anonSessionLike(userId: string) {
  return { ...storeSessionLike(userId), user: { id: userId, email: null, is_anonymous: true } };
}

describe("auth-store", () => {
  it("hydrate populates session from backend auth", async () => {
    authMock.getSession.mockResolvedValueOnce(session);
    authMock.onAuthStateChange.mockImplementation(() => {});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.user.id).toBe("u1");
    expect(useAuthStore.getState().session?.access_token).toBe("access-1");
    expect(useAuthStore.getState().session?.refresh_token).toBe("refresh-1");
    expect(useAuthStore.getState().session?.expires_at).toBe(12345);
    expect(useAuthStore.getState().loading).toBe(false);
  });

  it("hydrate auth listener stores token compatibility aliases", async () => {
    authMock.getSession.mockResolvedValueOnce(null);
    authMock.onAuthStateChange.mockImplementation((listener) => {
      listener({
        user: { id: "u-listener", email: "listener@example.com" },
        accessToken: "access-listener",
        refreshToken: "refresh-listener",
        expiresAt: 67890,
      });
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session).toMatchObject({
      user: { id: "u-listener" },
      accessToken: "access-listener",
      refreshToken: "refresh-listener",
      expiresAt: 67890,
      access_token: "access-listener",
      refresh_token: "refresh-listener",
      expires_at: 67890,
    });
  });

  it("sendOtp stashes email and returns true on success", async () => {
    authMock.sendOtp.mockResolvedValueOnce(undefined);
    const ok = await useAuthStore.getState().sendOtp("a@b.com");
    expect(ok).toBe(true);
    expect(authMock.sendOtp).toHaveBeenCalledWith("a@b.com");
    expect(useAuthStore.getState().otpEmail).toBe("a@b.com");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("sendOtp captures error and returns false on failure", async () => {
    authMock.sendOtp.mockRejectedValueOnce(new Error("rate limit"));
    const ok = await useAuthStore.getState().sendOtp("a@b.com");
    expect(ok).toBe(false);
    expect(useAuthStore.getState().errorMessage).toBe("rate limit");
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("sendOtp returns a config error without calling Supabase when config is missing", async () => {
    backendConfig.hasConfig = false;

    const ok = await useAuthStore.getState().sendOtp("a@b.com");

    expect(ok).toBe(false);
    expect(authMock.sendOtp).not.toHaveBeenCalled();
    expect(useAuthStore.getState().errorMessage).toMatch(/Supabase config missing/);
  });

  it("verifyOtp sets session on success", async () => {
    useAuthStore.setState({ otpEmail: "a@b.com" });
    authMock.verifyOtp.mockResolvedValueOnce({ user: { id: "u2" } });
    await useAuthStore.getState().verifyOtp("123456");
    expect(authMock.verifyOtp).toHaveBeenCalledWith("a@b.com", "123456");
    expect(useAuthStore.getState().session?.user.id).toBe("u2");
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("verifyOtp captures error message on failure", async () => {
    useAuthStore.setState({ otpEmail: "a@b.com" });
    authMock.verifyOtp.mockRejectedValueOnce(new Error("Invalid code"));
    await useAuthStore.getState().verifyOtp("000000");
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().errorMessage).toBe("Invalid code");
  });

  it("verifyOtp errors when no pending email", async () => {
    await useAuthStore.getState().verifyOtp("123456");
    expect(useAuthStore.getState().errorMessage).toMatch(/No pending sign-in/);
  });

  it("sendPhoneOtp stashes phone and returns true on success", async () => {
    authMock.sendPhoneOtp.mockResolvedValueOnce(undefined);
    const ok = await useAuthStore.getState().sendPhoneOtp("+8613800138000");
    expect(ok).toBe(true);
    expect(authMock.sendPhoneOtp).toHaveBeenCalledWith("+8613800138000");
    expect(useAuthStore.getState().otpPhone).toBe("+8613800138000");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("sendPhoneOtp captures error and returns false on failure", async () => {
    authMock.sendPhoneOtp.mockRejectedValueOnce(new Error("sms rate limit"));
    const ok = await useAuthStore.getState().sendPhoneOtp("+8613800138000");
    expect(ok).toBe(false);
    expect(useAuthStore.getState().errorMessage).toBe("sms rate limit");
    expect(useAuthStore.getState().otpPhone).toBeNull();
  });

  it("verifyPhoneOtp sets session on success", async () => {
    useAuthStore.setState({ otpPhone: "+8613800138000" });
    authMock.verifyPhoneOtpResult.mockResolvedValueOnce({
      type: "session",
      session: storeSessionLike("p2"),
    });
    await useAuthStore.getState().verifyPhoneOtp("123456");
    expect(authMock.verifyPhoneOtpResult).toHaveBeenCalledWith("+8613800138000", "123456");
    expect(useAuthStore.getState().session?.user.id).toBe("p2");
    expect(useAuthStore.getState().otpPhone).toBeNull();
  });

  it("verifyPhoneOtp errors when no pending phone", async () => {
    await useAuthStore.getState().verifyPhoneOtp("123456");
    expect(useAuthStore.getState().errorMessage).toMatch(/No pending sign-in/);
  });

  it("signOut clears session and pending otp", async () => {
    useAuthStore.setState({ session: { user: { id: "u" } }, otpEmail: "a@b.com", otpPhone: "+8613800138000" });
    authMock.signOut.mockResolvedValueOnce(undefined);
    await useAuthStore.getState().signOut();
    expect(authMock.signOut).toHaveBeenCalled();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().otpEmail).toBeNull();
    expect(useAuthStore.getState().otpPhone).toBeNull();
  });

  it("signInAnonymously sets the returned session", async () => {
    authMock.signInAnonymously.mockResolvedValueOnce({ user: { id: "anon-1" } });

    const ok = await useAuthStore.getState().signInAnonymously();

    expect(ok).toBe(true);
    expect(useAuthStore.getState().session?.user.id).toBe("anon-1");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("signInAnonymously returns a config error without calling Supabase when config is missing", async () => {
    backendConfig.hasConfig = false;

    const ok = await useAuthStore.getState().signInAnonymously();

    expect(ok).toBe(false);
    expect(authMock.signInAnonymously).not.toHaveBeenCalled();
    expect(useAuthStore.getState().errorMessage).toMatch(/Supabase config missing/);
  });

  it("claimInvite claims the token through backend auth", async () => {
    authMock.claimInvite.mockResolvedValueOnce({
      actorId: "actor-1",
      teamId: "team-1",
      actorType: "member",
      displayName: "Alice",
      refreshToken: null,
    });

    const result = await useAuthStore.getState().claimInvite("tok-1");

    expect(authMock.claimInvite).toHaveBeenCalledWith("tok-1");
    expect(result?.teamId).toBe("team-1");
  });

  it("setPendingInviteToken stores the token", () => {
    useAuthStore.getState().setPendingInviteToken("tok-2");
    expect(useAuthStore.getState().pendingInviteToken).toBe("tok-2");
  });

  it("claimPendingInvite is a no-op for an anonymous session (keeps the token)", async () => {
    useAuthStore.setState({ session: anonSessionLike("anon-2"), pendingInviteToken: "tok-2" });

    const result = await useAuthStore.getState().claimPendingInvite();

    expect(result).toBeNull();
    expect(authMock.claimInvite).not.toHaveBeenCalled();
    expect(useAuthStore.getState().pendingInviteToken).toBe("tok-2");
  });

  it("claimPendingInvite claims and enters the team for a real session", async () => {
    authMock.claimInvite.mockResolvedValueOnce({
      actorId: "actor-4",
      teamId: "team-4",
      actorType: "member",
      displayName: "Dana",
      refreshToken: null,
    });
    useAuthStore.setState({ session: storeSessionLike("real-4"), pendingInviteToken: "tok-4" });

    const result = await useAuthStore.getState().claimPendingInvite();

    expect(authMock.claimInvite).toHaveBeenCalledWith("tok-4");
    expect(currentTeamMock.reloadAndSwitchTo).toHaveBeenCalledWith("team-4");
    expect(result?.teamId).toBe("team-4");
    expect(useAuthStore.getState().pendingInviteToken).toBeNull();
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().authFlow).toBe("idle");
  });

  it("sendUpgradeEmailOtp does not flip the global loading flag (AuthGate would tear down the app)", async () => {
    // Authenticated, app mounted: session present, global loading already false.
    useAuthStore.setState({ session: storeSessionLike("anon-up"), loading: false, upgradeEmail: null });
    const pending = deferred<void>();
    authMock.sendUpgradeEmailOtp.mockReturnValueOnce(pending.promise);

    const resultPromise = useAuthStore.getState().sendUpgradeEmailOtp("taken@example.com");

    // While in-flight the global `loading` must stay false so AuthGate keeps the
    // app (and the upgrade dialog) mounted; the dedicated flag tracks progress.
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().upgradeLoading).toBe(true);

    pending.resolve();
    await resultPromise;
    expect(useAuthStore.getState().upgradeLoading).toBe(false);
  });

  it("sendUpgradeEmailOtp surfaces the error without disturbing global loading on failure", async () => {
    useAuthStore.setState({ session: storeSessionLike("anon-up"), loading: false, upgradeEmail: null });
    authMock.sendUpgradeEmailOtp.mockRejectedValueOnce(
      new Error("A user with this email address has already been registered"),
    );

    const ok = await useAuthStore.getState().sendUpgradeEmailOtp("taken@example.com");

    expect(ok).toBe(false);
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().upgradeLoading).toBe(false);
    expect(useAuthStore.getState().errorMessage).toMatch(/already been registered/);
    expect(useAuthStore.getState().upgradeEmail).toBeNull();
  });

  it("verifyUpgradeEmailOtp does not flip the global loading flag while verifying", async () => {
    useAuthStore.setState({ session: storeSessionLike("anon-up"), loading: false, upgradeEmail: "taken@example.com" });
    const pending = deferred<{ user: { id: string } }>();
    authMock.verifyUpgradeEmailOtp.mockReturnValueOnce(pending.promise);

    const resultPromise = useAuthStore.getState().verifyUpgradeEmailOtp("123456");

    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().upgradeLoading).toBe(true);

    pending.resolve({ user: { id: "anon-up" } });
    await resultPromise;
    expect(useAuthStore.getState().upgradeLoading).toBe(false);
  });

  it("claimPendingInvite keeps the token for retry when the claim fails", async () => {
    authMock.claimInvite.mockRejectedValueOnce(new Error("Invite expired"));
    useAuthStore.setState({ session: storeSessionLike("real-3"), pendingInviteToken: "expired" });

    const result = await useAuthStore.getState().claimPendingInvite();

    expect(result).toBeNull();
    expect(useAuthStore.getState().pendingInviteToken).toBe("expired");
    expect(useAuthStore.getState().authFlow).toBe("idle");
    expect(useAuthStore.getState().errorMessage).toBe("Invite expired");
  });
});

describe("signInWithWebSso", () => {
  it("adopts the harvested refresh token and sets the session", async () => {
    (runWebSso as ReturnType<typeof vi.fn>).mockResolvedValue("RT");
    const adopted = { accessToken: "AT", refreshToken: "RT", user: { id: "u1" } };
    authMock.adoptSession.mockResolvedValue(adopted);
    const ok = await useAuthStore.getState().signInWithWebSso();
    expect(ok).toBe(true);
    expect(authMock.adoptSession).toHaveBeenCalledWith("RT");
    expect(useAuthStore.getState().session?.access_token).toBe("AT");
    expect(useAuthStore.getState().webSsoPending).toBe(false);
  });

  it("resets pending without an error message when cancelled", async () => {
    (runWebSso as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("cancelled"), { code: "websso_cancelled" }),
    );
    const ok = await useAuthStore.getState().signInWithWebSso();
    expect(ok).toBe(false);
    expect(useAuthStore.getState().webSsoPending).toBe(false);
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("cancelWebSso delegates to the lib", () => {
    useAuthStore.setState({ webSsoPending: true });
    useAuthStore.getState().cancelWebSso();
    expect(cancelWebSso).toHaveBeenCalled();
  });
});
