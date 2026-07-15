import { describe, expect, it } from "vitest";

describe("isActorOnline", () => {
  it("returns true for last_active_at within the 5-minute window", async () => {
    const { isActorOnline } = await import("../features/actors/actor-types");
    const now = Date.UTC(2026, 4, 19, 18, 0, 0);
    expect(
      isActorOnline(
        {
          actorId: "a",
          teamId: "t",
          actorType: "member",
          displayName: "Test",
          role: "member",
          lastActiveAt: new Date(now - 60 * 1000).toISOString(),
          avatarUrl: null,
          agentTypes: [],
          defaultAgentType: null,
          agentKind: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it("returns false for last_active_at older than 5 minutes", async () => {
    const { isActorOnline } = await import("../features/actors/actor-types");
    const now = Date.UTC(2026, 4, 19, 18, 0, 0);
    expect(
      isActorOnline(
        {
          actorId: "a",
          teamId: "t",
          actorType: "member",
          displayName: "Test",
          role: "member",
          lastActiveAt: new Date(now - 10 * 60 * 1000).toISOString(),
          avatarUrl: null,
          agentTypes: [],
          defaultAgentType: null,
          agentKind: null,
        },
        now,
      ),
    ).toBe(false);
  });

  it("returns false when last_active_at is missing", async () => {
    const { isActorOnline } = await import("../features/actors/actor-types");
    expect(
      isActorOnline({
        actorId: "a",
        teamId: "t",
        actorType: "member",
        displayName: "Test",
        role: null,
        lastActiveAt: null,
        avatarUrl: null,
        agentTypes: [],
        defaultAgentType: null,
        agentKind: null,
      }),
    ).toBe(false);
  });
});
