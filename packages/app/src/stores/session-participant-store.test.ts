import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionParticipantStore } from "./session-participant-store";

const listParticipants = vi.hoisted(() => vi.fn());

vi.mock("@/lib/utils", () => ({
  isTauri: vi.fn(() => true),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessionMembers: {
      listParticipants,
    },
  }),
}));

vi.mock("@/lib/local-cache", () => ({
  loadSessionParticipants: vi.fn(async (sessionId: string) => {
    if (sessionId === "s1") return [{ actorId: "a1" }, { actorId: "agent-1" }];
    return [];
  }),
  loadActorsByIds: vi.fn(async (ids: string[]) =>
    ids.map((id) => ({
      id,
      displayName: id === "agent-1" ? "Agent One" : "Alice",
      avatarUrl: null,
      actorType: id.startsWith("agent") ? "agent" : "member",
    })),
  ),
}));

vi.mock("@/lib/sync/session-participant-sync", () => ({
  syncParticipantsForSession: vi.fn(async () => 1),
}));

beforeEach(async () => {
  const { isTauri } = await import("@/lib/utils");
  vi.mocked(isTauri).mockReturnValue(true);
  listParticipants.mockReset();
  useSessionParticipantStore.setState({
    participantsBySession: {},
    loadingBySession: {},
    errorBySession: {},
  });
  vi.clearAllMocks();
});

describe("session-participant-store", () => {
  it("loads participants from the local cache", async () => {
    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    expect(useSessionParticipantStore.getState().participantsBySession.s1).toEqual([
      {
        actorId: "a1",
        displayName: "Alice",
        avatarUrl: null,
        isAgent: false,
      },
      {
        actorId: "agent-1",
        displayName: "Agent One",
        avatarUrl: null,
        isAgent: true,
      },
    ]);
  });

  it("invalidates cached sessions", async () => {
    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    useSessionParticipantStore.getState().invalidateSessions(["s1"]);

    expect(useSessionParticipantStore.getState().participantsBySession.s1).toBeUndefined();
  });

  it("syncs before refreshing when team id is available", async () => {
    const sync = await import("@/lib/sync/session-participant-sync");

    await useSessionParticipantStore.getState().refreshSession("s1", "team-1");

    expect(sync.syncParticipantsForSession).toHaveBeenCalledWith("s1", "team-1", {
      full: true,
    });
    expect(useSessionParticipantStore.getState().participantsBySession.s1).toHaveLength(2);
  });

  it("loads participants from Cloud API in extension/web mode", async () => {
    const { isTauri } = await import("@/lib/utils");
    vi.mocked(isTauri).mockReturnValue(false);
    listParticipants.mockResolvedValue([
      {
        id: "member-1",
        team_id: "team-1",
        display_name: "Alice",
        actor_type: "member",
      },
      {
        id: "agent-1",
        team_id: "team-1",
        display_name: "MACPRO",
        actor_type: "agent",
      },
    ]);

    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    expect(listParticipants).toHaveBeenCalledWith("s1");
    expect(useSessionParticipantStore.getState().participantsBySession.s1).toEqual([
      {
        actorId: "member-1",
        displayName: "Alice",
        avatarUrl: null,
        isAgent: false,
      },
      {
        actorId: "agent-1",
        displayName: "MACPRO",
        avatarUrl: null,
        isAgent: true,
      },
    ]);
  });
});
