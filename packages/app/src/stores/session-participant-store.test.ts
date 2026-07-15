import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionParticipantStore } from "./session-participant-store";

const { mockListParticipants, mockIsTauri } = vi.hoisted(() => ({
  mockListParticipants: vi.fn(async () => [] as Array<{
    id: string;
    actor_type: string | null;
    display_name: string | null;
    avatar_url: string | null;
  }>),
  mockIsTauri: vi.fn(() => true),
}));

vi.mock("@/lib/utils", () => ({
  isTauri: mockIsTauri,
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessionMembers: {
      listParticipants: mockListParticipants,
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

beforeEach(() => {
  mockIsTauri.mockReturnValue(true);
  mockListParticipants.mockResolvedValue([]);
  useSessionParticipantStore.setState({
    participantsBySession: {},
    loadingBySession: {},
    errorBySession: {},
  });
  vi.clearAllMocks();
  mockIsTauri.mockReturnValue(true);
});

describe("session-participant-store", () => {
  it("loads participants from the local cache on desktop", async () => {
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

  it("loads participants from Cloud API on extension/web", async () => {
    mockIsTauri.mockReturnValue(false);
    mockListParticipants.mockResolvedValue([
      {
        id: "member-1",
        actor_type: "member",
        display_name: "Alice",
        avatar_url: null,
      },
      {
        id: "daemon-1",
        actor_type: "agent",
        display_name: "MACPRO",
        avatar_url: null,
      },
    ]);

    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    expect(mockListParticipants).toHaveBeenCalledWith("s1");
    expect(useSessionParticipantStore.getState().participantsBySession.s1).toEqual([
      {
        actorId: "member-1",
        displayName: "Alice",
        avatarUrl: null,
        isAgent: false,
      },
      {
        actorId: "daemon-1",
        displayName: "MACPRO",
        avatarUrl: null,
        isAgent: true,
      },
    ]);
  });

  it("retries empty cache on extension/web", async () => {
    mockIsTauri.mockReturnValue(false);
    useSessionParticipantStore.setState({
      participantsBySession: { s1: [] },
      loadingBySession: {},
      errorBySession: {},
    });
    mockListParticipants.mockResolvedValue([
      {
        id: "daemon-1",
        actor_type: "agent",
        display_name: "MACPRO",
        avatar_url: null,
      },
    ]);

    await useSessionParticipantStore.getState().ensureParticipants(["s1"]);

    expect(mockListParticipants).toHaveBeenCalledWith("s1");
    expect(useSessionParticipantStore.getState().participantsBySession.s1).toEqual([
      {
        actorId: "daemon-1",
        displayName: "MACPRO",
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
    mockIsTauri.mockReturnValue(false);
    mockListParticipants.mockResolvedValue([
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

    expect(mockListParticipants).toHaveBeenCalledWith("s1");
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
