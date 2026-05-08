import { describe, it, expect, vi, beforeEach } from "vitest";

const supabaseMock = {
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  },
};

vi.mock("@/lib/supabase-client", () => ({
  supabase: supabaseMock,
}));

const { useAuthStore } = await import("./auth-store");

beforeEach(() => {
  Object.values(supabaseMock.auth).forEach((fn) => fn.mockReset());
  useAuthStore.setState({ session: null, loading: true, errorMessage: null });
});

describe("auth-store", () => {
  it("hydrate populates session from supabase.auth.getSession", async () => {
    supabaseMock.auth.getSession.mockResolvedValueOnce({ data: { session: { user: { id: "u1" } } } });
    supabaseMock.auth.onAuthStateChange.mockImplementation(() => {});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.user.id).toBe("u1");
    expect(useAuthStore.getState().loading).toBe(false);
  });

  it("signIn sets session on success", async () => {
    supabaseMock.auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: { user: { id: "u2" } } },
      error: null,
    });
    await useAuthStore.getState().signIn("e", "p");
    expect(useAuthStore.getState().session?.user.id).toBe("u2");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("signIn captures error message on failure", async () => {
    supabaseMock.auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "Invalid credentials" },
    });
    await useAuthStore.getState().signIn("e", "p");
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().errorMessage).toBe("Invalid credentials");
  });

  it("signOut clears session", async () => {
    useAuthStore.setState({ session: { user: { id: "u" } } as any });
    supabaseMock.auth.signOut.mockResolvedValueOnce({ error: null });
    await useAuthStore.getState().signOut();
    expect(useAuthStore.getState().session).toBeNull();
  });
});
