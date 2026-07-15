import { describe, it, expect, vi, beforeEach } from "vitest";

const teamsMock = {
  listCurrentUserTeams: vi.fn(),
  getTeam: vi.fn(),
  renameTeam: vi.fn(),
};
const directoryMock = {
  getCurrentTeamMember: vi.fn(),
};
const backendMock = {
  teams: teamsMock,
  directory: directoryMock,
};

const authState: { session: { user: { id: string } } | null } = {
  session: { user: { id: "anon-1" } },
};

vi.mock("@/lib/backend", () => ({
  getBackend: () => backendMock,
}));

vi.mock("./auth-store", () => ({
  useAuthStore: {
    getState: () => authState,
  },
}));

// current-team dynamically imports the Tauri core to set the local-cache gate;
// stub it so the store runs in the jsdom test environment.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const { useCurrentTeamStore, readCachedCurrentTeam, writeCachedCurrentTeam, initialCurrentTeamState } =
  await import("./current-team");

const ACTIVE_TEAM = { id: "team-1", name: "Brave Otter", slug: "brave-otter" };
const ACTIVE_MEMBER = {
  id: "member-1",
  displayName: "You",
  role: "owner",
  joinedAt: "2026-05-29T00:00:00.000Z",
};

beforeEach(() => {
  teamsMock.listCurrentUserTeams.mockReset();
  directoryMock.getCurrentTeamMember.mockReset();
  authState.session = { user: { id: "anon-1" } };
  localStorage.clear();
  useCurrentTeamStore.setState({
    team: null,
    currentMember: null,
    teamUserId: null,
    loading: false,
    saving: false,
    error: null,
  });
});

describe("current-team persistence cache", () => {
  it("persists the resolved team so a later launch can hydrate it synchronously", async () => {
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([ACTIVE_TEAM]);
    directoryMock.getCurrentTeamMember.mockResolvedValueOnce(ACTIVE_MEMBER);

    await useCurrentTeamStore.getState().load();

    expect(readCachedCurrentTeam()).toEqual({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
  });

  it("clears the persisted team when the session resolves team-less", async () => {
    writeCachedCurrentTeam({ team: ACTIVE_TEAM, currentMember: ACTIVE_MEMBER, teamUserId: "anon-1" });
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([]);

    await useCurrentTeamStore.getState().load();

    expect(readCachedCurrentTeam()).toBeNull();
  });

  it("hydrates initial store state from a persisted cache", () => {
    writeCachedCurrentTeam({ team: ACTIVE_TEAM, currentMember: ACTIVE_MEMBER, teamUserId: "anon-1" });

    expect(initialCurrentTeamState()).toEqual({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
  });

  it("ignores a malformed cache entry", () => {
    localStorage.setItem("teamclaw:current-team", "not json{");
    expect(readCachedCurrentTeam()).toBeNull();
    expect(initialCurrentTeamState()).toEqual({ team: null, currentMember: null, teamUserId: null });
  });
});

describe("useCurrentTeamStore.load", () => {
  it("does not clobber an already-active team when the list comes back empty (RLS replica lag)", async () => {
    // AuthGate already populated the store with the freshly auto-created team
    // for THIS user (teamUserId matches the session).
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "anon-1",
    });
    // The follow-up list query can't see the just-written membership yet.
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([]);

    await useCurrentTeamStore.getState().load();

    const state = useCurrentTeamStore.getState();
    expect(state.team).toEqual(ACTIVE_TEAM);
    expect(state.currentMember).toEqual(ACTIVE_MEMBER);
    expect(state.loading).toBe(false);
    // We bailed before re-fetching the member.
    expect(directoryMock.getCurrentTeamMember).not.toHaveBeenCalled();
  });

  it("does NOT preserve a team belonging to a different user (logout + re-login)", async () => {
    // Previous user's team still in the store, new session is a different user.
    useCurrentTeamStore.setState({
      team: ACTIVE_TEAM,
      currentMember: ACTIVE_MEMBER,
      teamUserId: "prev-user",
    });
    authState.session = { user: { id: "anon-1" } };
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([]);

    await useCurrentTeamStore.getState().load();

    // The foreign team must be cleared, not carried into the new user's session.
    const state = useCurrentTeamStore.getState();
    expect(state.team).toBeNull();
    expect(state.currentMember).toBeNull();
  });

  it("clears the team for a genuinely team-less session (empty list, no prior team)", async () => {
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([]);

    await useCurrentTeamStore.getState().load();

    const state = useCurrentTeamStore.getState();
    expect(state.team).toBeNull();
    expect(state.currentMember).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("loads the team and current member when the list returns a team", async () => {
    teamsMock.listCurrentUserTeams.mockResolvedValueOnce([ACTIVE_TEAM]);
    directoryMock.getCurrentTeamMember.mockResolvedValueOnce(ACTIVE_MEMBER);

    await useCurrentTeamStore.getState().load();

    const state = useCurrentTeamStore.getState();
    expect(state.team).toEqual(ACTIVE_TEAM);
    expect(state.currentMember).toEqual(ACTIVE_MEMBER);
    expect(directoryMock.getCurrentTeamMember).toHaveBeenCalledWith("team-1", "anon-1");
  });
});
