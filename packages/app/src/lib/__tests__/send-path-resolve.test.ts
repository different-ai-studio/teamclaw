import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAgentRuntimeIdsForSend,
  resolveSendTeamId,
  trySyncMentionActorIds,
} from "../send-path-resolve";

const mocks = vi.hoisted(() => ({
  participantsBySession: {} as Record<
    string,
    Array<{ actorId: string; displayName: string; avatarUrl: null; isAgent: boolean }>
  >,
  engaged: null as { id: string; displayName: string } | null,
}));

vi.mock("@/stores/session-participant-store", () => ({
  useSessionParticipantStore: {
    getState: () => ({
      participantsBySession: mocks.participantsBySession,
    }),
  },
}));

vi.mock("@/stores/engaged-agent-store", () => ({
  useEngagedAgentStore: {
    getState: () => ({
      get: () => mocks.engaged,
    }),
  },
}));

describe("trySyncMentionActorIds", () => {
  it("returns sync ids when pill agent is set and body has no @Name", () => {
    expect(trySyncMentionActorIds(["m1"], ["a1"], "hello")).toEqual(["m1", "a1"]);
  });

  it("returns null when body has @Name tokens", () => {
    expect(trySyncMentionActorIds([], ["a1"], "hi @Bob")).toBeNull();
  });

  it("returns null when no agent pill (solo fallback needs async)", () => {
    expect(trySyncMentionActorIds([], [], "hello")).toBeNull();
  });
});

describe("resolveSendTeamId", () => {
  it("uses the session-list row without hitting the backend", async () => {
    const fetchSessionTeamId = vi.fn();
    await expect(
      resolveSendTeamId({
        sessionId: "s1",
        teamIdFromSessionList: "team-row",
        fetchSessionTeamId,
        currentTeamId: () => "team-selected",
      }),
    ).resolves.toBe("team-row");
    expect(fetchSessionTeamId).not.toHaveBeenCalled();
  });

  it("prefers the session's own team over the selected team", async () => {
    await expect(
      resolveSendTeamId({
        sessionId: "s1",
        teamIdFromSessionList: null,
        fetchSessionTeamId: async () => "team-of-session",
        currentTeamId: () => "team-selected",
      }),
    ).resolves.toBe("team-of-session");
  });

  it("falls back to the selected team only when the backend has none", async () => {
    await expect(
      resolveSendTeamId({
        sessionId: "s1",
        teamIdFromSessionList: null,
        fetchSessionTeamId: async () => null,
        currentTeamId: () => "team-selected",
      }),
    ).resolves.toBe("team-selected");
  });
});

describe("resolveAgentRuntimeIdsForSend", () => {
  beforeEach(() => {
    mocks.participantsBySession = {};
    mocks.engaged = null;
  });

  it("prefers the engaged / preselected agent id", () => {
    expect(resolveAgentRuntimeIdsForSend("s1", "a1", ["a1", "m1"])).toEqual(["a1"]);
  });

  it("filters mention ids through the roster cache", () => {
    mocks.participantsBySession = {
      s1: [
        { actorId: "a1", displayName: "Bot", avatarUrl: null, isAgent: true },
        { actorId: "m1", displayName: "Me", avatarUrl: null, isAgent: false },
      ],
    };
    expect(resolveAgentRuntimeIdsForSend("s1", null, ["a1", "m1"])).toEqual(["a1"]);
  });
});
