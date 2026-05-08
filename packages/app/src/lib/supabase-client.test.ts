import { describe, it, expect, vi, beforeAll } from "vitest";

// Stub env vars before the module is imported
beforeAll(() => {
  // @ts-expect-error -- import.meta.env is writable in Vitest
  import.meta.env.VITE_SUPABASE_URL = "https://test.supabase.co";
  // @ts-expect-error -- import.meta.env is writable in Vitest
  import.meta.env.VITE_SUPABASE_ANON_KEY = "test-anon-key";
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
    },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    })),
  })),
}));

describe("supabase-client", () => {
  it("exports a configured supabase client", async () => {
    const mod = await import("./supabase-client");
    expect(mod.supabase).toBeDefined();
    expect(typeof mod.listSessionsForUser).toBe("function");
  });

  it("listSessionsForUser returns an array", async () => {
    const { listSessionsForUser } = await import("./supabase-client");
    const result = await listSessionsForUser("user-123");
    expect(Array.isArray(result)).toBe(true);
  });
});
