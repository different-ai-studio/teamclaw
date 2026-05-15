import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@supabase/supabase-js";

const supabaseMock = {
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signInWithOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signOut: vi.fn(),
  },
};

vi.mock("@/lib/supabase-client", () => ({
  supabase: supabaseMock,
}));

const { useAuthStore } = await import("./auth-store");

beforeEach(() => {
  Object.values(supabaseMock.auth).forEach((fn) => fn.mockReset());
  useAuthStore.setState({
    session: null,
    loading: true,
    errorMessage: null,
    otpEmail: null,
  });
});

describe("auth-store", () => {
  it("hydrate populates session from supabase.auth.getSession", async () => {
    supabaseMock.auth.getSession.mockResolvedValueOnce({ data: { session: { user: { id: "u1" } } } });
    supabaseMock.auth.onAuthStateChange.mockImplementation(() => {});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.user.id).toBe("u1");
    expect(useAuthStore.getState().loading).toBe(false);
  });

  it("sendOtp stashes email and returns true on success", async () => {
    supabaseMock.auth.signInWithOtp.mockResolvedValueOnce({ error: null });
    const ok = await useAuthStore.getState().sendOtp("a@b.com");
    expect(ok).toBe(true);
    expect(useAuthStore.getState().otpEmail).toBe("a@b.com");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("sendOtp captures error and returns false on failure", async () => {
    supabaseMock.auth.signInWithOtp.mockResolvedValueOnce({ error: { message: "rate limit" } });
    const ok = await useAuthStore.getState().sendOtp("a@b.com");
    expect(ok).toBe(false);
    expect(useAuthStore.getState().errorMessage).toBe("rate limit");
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("verifyOtp sets session on success", async () => {
    useAuthStore.setState({ otpEmail: "a@b.com" });
    supabaseMock.auth.verifyOtp.mockResolvedValueOnce({
      data: { session: { user: { id: "u2" } } },
      error: null,
    });
    await useAuthStore.getState().verifyOtp("123456");
    expect(useAuthStore.getState().session?.user.id).toBe("u2");
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("verifyOtp captures error message on failure", async () => {
    useAuthStore.setState({ otpEmail: "a@b.com" });
    supabaseMock.auth.verifyOtp.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "Invalid code" },
    });
    await useAuthStore.getState().verifyOtp("000000");
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().errorMessage).toBe("Invalid code");
  });

  it("verifyOtp errors when no pending email", async () => {
    await useAuthStore.getState().verifyOtp("123456");
    expect(useAuthStore.getState().errorMessage).toMatch(/No pending sign-in/);
  });

  it("signOut clears session and pending otp", async () => {
    useAuthStore.setState({ session: { user: { id: "u" } } as unknown as Session, otpEmail: "a@b.com" });
    supabaseMock.auth.signOut.mockResolvedValueOnce({ error: null });
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });
});
