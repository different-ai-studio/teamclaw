import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listParticipants: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessionMembers: { listParticipants: mocks.listParticipants },
  }),
}));

vi.mock("@/lib/resolve-text-mentions", () => ({
  resolveActorIdsFromAtText: vi.fn(async () => ({
    agentIds: [] as string[],
    memberIds: [] as string[],
  })),
}));

import { resolveActorIdsFromAtText } from "@/lib/resolve-text-mentions";
import { resolveSessionMentionActorIds } from "@/lib/resolve-session-mention-ids";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";

describe("resolveSessionMentionActorIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEngagedAgentStore.setState({ bySession: {} });
    mocks.listParticipants.mockResolvedValue([]);
  });

  it("returns engaged pill agent id when provided", async () => {
    const ids = await resolveSessionMentionActorIds(
      "session-1",
      [],
      ["agent-1"],
    );
    expect(ids).toEqual(["agent-1"]);
  });

  it("returns member ids from explicit mentions", async () => {
    const ids = await resolveSessionMentionActorIds(
      "session-1",
      ["member-1"],
      [],
    );
    expect(ids).toEqual(["member-1"]);
  });

  it("does not fallback to sole session agent when nothing is explicit", async () => {
    mocks.listParticipants.mockResolvedValue([
      { id: "agent-1", actor_type: "agent", display_name: "Bot" },
      { id: "member-1", actor_type: "member", display_name: "Alice" },
      { id: "member-2", actor_type: "member", display_name: "Bob" },
    ]);

    const ids = await resolveSessionMentionActorIds("session-1", [], []);
    expect(ids).toEqual([]);
  });

  it("merges typed @agent from message text", async () => {
    vi.mocked(resolveActorIdsFromAtText).mockResolvedValueOnce({
      agentIds: ["agent-2"],
      memberIds: [],
    });
    mocks.listParticipants.mockResolvedValue([
      { id: "agent-2", actor_type: "agent", display_name: "MAC" },
    ]);

    const ids = await resolveSessionMentionActorIds(
      "session-1",
      [],
      [],
      "@MAC hello",
    );
    expect(ids).toEqual(["agent-2"]);
    expect(useEngagedAgentStore.getState().bySession["session-1"]).toEqual([
      { id: "agent-2", displayName: "MAC" },
    ]);
  });
});
