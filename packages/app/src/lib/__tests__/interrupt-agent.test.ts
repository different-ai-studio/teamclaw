import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromBinary } from "@bufbuild/protobuf";
import { AgentType, RuntimeCommandEnvelopeSchema, RuntimeLifecycle } from "@/lib/proto/amux_pb";
import type { RuntimeStateEntry } from "@/stores/runtime-state-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

const mqttPublish = vi.fn().mockResolvedValue(undefined);
const mockByRuntimeId: Record<string, RuntimeStateEntry> = {};

/** A retain entry as the daemon files it: keyed by session id. */
function seedAttachment(sessionId: string, runtimeId: string) {
  mockByRuntimeId[`agent-a::${sessionId}`] = {
    daemonActorId: "agent-a",
    lastUpdated: Date.now(),
    info: {
      runtimeId,
      agentType: AgentType.OPENCODE,
      availableModels: [],
      currentModel: "",
      state: RuntimeLifecycle.ACTIVE,
    } as RuntimeStateEntry["info"],
  };
}

vi.mock("@/lib/mqtt-bridge", () => ({
  mqttPublish: (...args: unknown[]) => mqttPublish(...args),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessionMembers: {
      listParticipants: vi.fn().mockResolvedValue([
        { id: "agent-a", actor_type: "agent" },
      ]),
    },
  }),
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => ({
      team: { id: "team-1" },
      currentMember: { id: "member-1" },
    }),
  },
}));

vi.mock("@/stores/runtime-state-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/runtime-state-store")>();
  return {
    ...actual,
    useRuntimeStateStore: { getState: () => ({ byRuntimeId: mockByRuntimeId }) },
  };
});

const discardPendingStreamReply = vi.fn();

vi.mock("@/lib/live-agent-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/live-agent-stream")>();
  return {
    ...actual,
    discardPendingStreamReply: (...args: [string, string]) =>
      discardPendingStreamReply(...args),
  };
});

import { interruptAgentActor } from "@/lib/teamclaw/interrupt-agent";

describe("interruptAgentActor", () => {
  beforeEach(() => {
    mqttPublish.mockClear();
    discardPendingStreamReply.mockClear();
    for (const key of Object.keys(mockByRuntimeId)) {
      delete mockByRuntimeId[key];
    }
    seedAttachment("session-1", "rt-abcd");
    useV2StreamingStore.setState({
      byKey: {},
      archived: [],
      interruptedFlushPending: {},
    });
    useV2StreamingStore.getState().appendOutput("session-1", "agent-a", "Hello");
  });

  it("publishes AcpCancel to the resolved runtime command topic", async () => {
    await interruptAgentActor({
      sessionId: "session-1",
      agentActorId: "agent-a",
    });

    expect(mqttPublish).toHaveBeenCalledTimes(1);
    const [topic, bytes] = mqttPublish.mock.calls[0] as [string, Uint8Array];
    expect(topic).toBe("amux/team-1/agent-a/runtime/rt-abcd/commands");

    const envelope = fromBinary(RuntimeCommandEnvelopeSchema, bytes);
    expect(envelope.acpCommand?.command.case).toBe("cancel");

    expect(discardPendingStreamReply).not.toHaveBeenCalled();
    expect(useV2StreamingStore.getState().byKey["session-1::agent-a"]?.active).toBe(true);
    expect(
      useV2StreamingStore.getState().isInterruptedFlushPending("session-1", "agent-a"),
    ).toBe(true);
  });

  it("never reaches for another session's attachment", async () => {
    // This replaces a test for "prefers the live retain when the DB row is
    // stale". There is no DB row to be stale: the retain keys attachments by
    // session and holds exactly one, so there is nothing to choose between —
    // which is what made the original bug possible
    // (docs/debug/interrupt-agent-stale-runtime.md).
    seedAttachment("some-other-session", "wrong-spawn");

    await interruptAgentActor({
      sessionId: "session-1",
      agentActorId: "agent-a",
    });

    const [topic] = mqttPublish.mock.calls[0] as [string, Uint8Array];
    expect(topic).toBe("amux/team-1/agent-a/runtime/rt-abcd/commands");
  });

  it("cleans up locally when the session is cold", async () => {
    // No attachment for this session — absence is the answer, not a failure.
    delete mockByRuntimeId["agent-a::session-1"];

    await expect(
      interruptAgentActor({
        sessionId: "session-1",
        agentActorId: "agent-a",
      }),
    ).rejects.toThrow(/Could not resolve agent runtime/);

    expect(mqttPublish).not.toHaveBeenCalled();
    expect(discardPendingStreamReply).toHaveBeenCalledWith("session-1", "agent-a");
    expect(useV2StreamingStore.getState().byKey["session-1::agent-a"]?.active).toBe(false);
    expect(
      useV2StreamingStore.getState().isInterruptedFlushPending("session-1", "agent-a"),
    ).toBe(false);
  });
});
