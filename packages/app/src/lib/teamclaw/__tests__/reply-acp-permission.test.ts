import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { AgentType } from "@/lib/proto/amux_pb";

const mocks = vi.hoisted(() => ({
  listParticipants: vi.fn(),
  mqttPublish: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessionMembers: { listParticipants: mocks.listParticipants },
  }),
}));

vi.mock("@/lib/mqtt-bridge", () => ({
  mqttPublish: mocks.mqttPublish,
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => ({
      team: { id: "team-1" },
      currentMember: { id: "member-actor-1" },
    }),
  },
}));

vi.mock("@/stores/v2-streaming-store", () => ({
  useV2StreamingStore: {
    getState: () => ({
      byKey: {
        "sess-1::agent-live": {
          sessionId: "sess-1",
          actorId: "agent-live",
          pendingPermissionsByRequestId: {
            "perm-uuid-1": {
              requestId: "perm-uuid-1",
              toolName: "bash",
              description: "run",
              params: {},
            },
          },
        },
      },
      clearPermissionRequest: vi.fn(),
    }),
  },
}));

describe("replyAcpPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeStateStore.getState().clear();
    mocks.listParticipants.mockResolvedValue([
      { id: "agent-live", actor_type: "agent" },
    ]);
    mocks.mqttPublish.mockResolvedValue(undefined);
  });

  it("addresses the attachment filed under this session, ignoring others", async () => {
    // Replaces "prefers session-bound runtime over stale MQTT retain": with the
    // retain keyed by session there is no second candidate to prefer over, which
    // is the whole point of dropping the per-spawn table (ADR-0004).
    useRuntimeStateStore.getState().upsert("agent-live::other-session", "agent-live", {
      runtimeId: "wrong-spawn",
      agentType: AgentType.OPENCODE,
      currentModel: "",
      availableModels: [],
      availableCommands: [],
      state: 0,
      status: 0,
    });
    useRuntimeStateStore.getState().upsert("agent-live::sess-1", "agent-live", {
      runtimeId: "live-spawn",
      agentType: AgentType.OPENCODE,
      currentModel: "",
      availableModels: [],
      availableCommands: [],
      state: 0,
      status: 0,
    });

    const { replyPermissionById } = await import("../reply-acp-permission");
    await replyPermissionById("perm-uuid-1", "allow");

    expect(mocks.mqttPublish).toHaveBeenCalledTimes(1);
    const topic = mocks.mqttPublish.mock.calls[0][0] as string;
    expect(topic).toBe(
      "amux/team-1/agent-live/runtime/live-spawn/commands",
    );
  });
});
