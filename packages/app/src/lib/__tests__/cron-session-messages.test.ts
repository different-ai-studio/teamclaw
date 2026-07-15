import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageKind } from "@/lib/proto/teamclaw_pb";
import { useSessionMessageStore } from "@/stores/session-message-store";

const mocks = vi.hoisted(() => ({
  listMessages: vi.fn(),
  getSessionTeamId: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    messages: { listMessages: mocks.listMessages },
    sessions: { getSessionTeamId: mocks.getSessionTeamId },
  }),
}));

vi.mock("@/lib/utils", () => ({
  isTauri: () => false,
}));

import { hydrateCronSessionMessages } from "../cron-session-messages";

beforeEach(() => {
  vi.clearAllMocks();
  useSessionMessageStore.setState({
    messages: {},
    messageRefreshTrigger: 0,
    messageRefreshForceFull: false,
  });
});

describe("hydrateCronSessionMessages", () => {
  it("maps cloud rows into the message store", async () => {
    mocks.listMessages.mockResolvedValueOnce([
      {
        id: "m1",
        team_id: "t1",
        session_id: "s1",
        turn_id: null,
        sender_actor_id: "agent-1",
        reply_to_message_id: null,
        kind: "agent_reply",
        content: "hello from cloud",
        metadata: null,
        model: null,
        created_at: "2026-06-01T07:00:00.000Z",
        updated_at: "2026-06-01T07:00:00.000Z",
      },
    ]);

    const count = await hydrateCronSessionMessages("s1");
    expect(count).toBe(1);
    const stored = useSessionMessageStore.getState().messages.s1;
    expect(stored).toHaveLength(1);
    expect(stored?.[0]?.content).toBe("hello from cloud");
    expect(stored?.[0]?.kind).toBe(MessageKind.AGENT_REPLY);
  });

  it("falls back to run summary when cloud has no messages", async () => {
    mocks.listMessages.mockResolvedValueOnce([]);

    const count = await hydrateCronSessionMessages("s1", {
      fallbackSummary: "北极熊笑话",
      runId: "run-1",
    });

    expect(count).toBe(1);
    const stored = useSessionMessageStore.getState().messages.s1;
    expect(stored?.[0]?.content).toBe("北极熊笑话");
    expect(stored?.[0]?.messageId).toBe("cron-summary-run-1");
  });
});
