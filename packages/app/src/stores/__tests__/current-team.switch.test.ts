import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];
const activateTeam = vi.fn(async (id: string) => { calls.push("activate"); return { actorId: "a", teamId: id, refreshToken: "rt" }; });
const adoptSession = vi.fn(async () => { calls.push("adopt"); return null; });
const getTeam = vi.fn(async (id: string) => { calls.push("getTeam"); return { id, name: "T", slug: "t", created_at: null }; });
const getCurrentTeamMember = vi.fn(async () => null);

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    teams: { activateTeam, getTeam },
    auth: { adoptSession },
    directory: { getCurrentTeamMember },
  }),
}));
vi.mock("@/lib/utils", () => ({ isTauri: () => false }));
vi.mock("../auth-store", () => ({
  useAuthStore: { getState: () => ({ session: { user: { id: "u1" } } }) },
}));

beforeEach(() => { calls.length = 0; vi.clearAllMocks(); });

describe("switchToTeam", () => {
  it("activates, adopts the new session, then switches team — in order", async () => {
    const { useCurrentTeamStore } = await import("../current-team");
    await useCurrentTeamStore.getState().switchToTeam("team-2");
    expect(calls).toEqual(["activate", "adopt", "getTeam"]);
    expect(useCurrentTeamStore.getState().team?.id).toBe("team-2");
  });

  it("on activate failure leaves team unchanged and surfaces error", async () => {
    activateTeam.mockRejectedValueOnce(new Error("forbidden"));
    const { useCurrentTeamStore } = await import("../current-team");
    const before = useCurrentTeamStore.getState().team;
    await expect(useCurrentTeamStore.getState().switchToTeam("team-x")).rejects.toThrow("forbidden");
    expect(useCurrentTeamStore.getState().team).toEqual(before);
    expect(adoptSession).not.toHaveBeenCalled();
  });
});
