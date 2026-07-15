import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclaw_pb";
import {
  cloneStreamEntrySnapshot,
  mergeSubagentSnapshotsIntoParts,
  persistStreamingPartsForReply,
  resolveStreamEntryForPersist,
} from "@/lib/streaming-persist";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

const localCacheMock = vi.hoisted(() => ({
  enrichMessageParts: vi.fn(async (partsJson: string) => partsJson),
  setMessageParts: vi.fn(async (_messageId: string, partsJson: string) => partsJson),
}));

vi.mock("@/lib/local-cache", () => localCacheMock);

beforeEach(() => {
  localCacheMock.enrichMessageParts.mockReset();
  localCacheMock.enrichMessageParts.mockImplementation(async (partsJson: string) => partsJson);
  localCacheMock.setMessageParts.mockReset();
  localCacheMock.setMessageParts.mockImplementation(async (_messageId: string, partsJson: string) => partsJson);
  useSessionMessageStore.setState({ messages: {}, messageRefreshTrigger: 0 });
  useV2StreamingStore.setState({
    byKey: {},
    archived: [],
    subagentByToolId: {},
    archivedSubagentByToolId: {},
    childAcpSessionToToolId: {},
  });
});

describe("mergeSubagentSnapshotsIntoParts", () => {
  it("writes subagentSnapshot onto renamed task tool parts", () => {
    const stream = useV2StreamingStore.getState();
    stream.pushToolUse("s1", "actor-a", {
      toolId: "task-tool-1",
      toolName: "Run pwd command",
      description: "Run pwd command",
      params: {
        subagent_type: "general",
        description: "Run pwd command",
        prompt: "pwd",
      },
      toolKind: "other",
    });
    stream.bindChildAcpSession("s1", "actor-a", "task-tool-1", "child-acp-1");
    stream.subAppendThinking("task-tool-1", "s1", "actor-a", "Checking cwd.");
    stream.subPushToolUse("task-tool-1", "s1", "actor-a", {
      toolId: "bash-1",
      toolName: "bash",
      description: "Print working directory",
      params: { command: "pwd" },
      toolKind: "execute",
    });
    stream.subCompleteToolUse("task-tool-1", "s1", "actor-a", {
      toolId: "bash-1",
      success: true,
      summary: "/Users/test/project",
    });

    const parentParts = useV2StreamingStore.getState().byKey["s1::actor-a"].parts;
    const merged = mergeSubagentSnapshotsIntoParts(parentParts, "s1", "actor-a");
    const taskPart = merged.find(
      (part) => part.type === "tool-call" && part.toolCall?.id === "task-tool-1",
    );

    expect(taskPart?.toolCall?.metadata?.childAcpSessionId).toBe("child-acp-1");
    expect(taskPart?.toolCall?.metadata?.subagentSnapshot?.length).toBeGreaterThan(0);
    expect(
      taskPart?.toolCall?.metadata?.subagentSnapshot?.some(
        (part) => part.type === "reasoning" && part.text?.includes("Checking cwd"),
      ),
    ).toBe(true);
  });

  it("writes independent snapshots for parallel task tools", () => {
    const stream = useV2StreamingStore.getState();
    const tasks = [
      { toolId: "task-us", childSid: "child-us", tag: "US" },
      { toolId: "task-eu", childSid: "child-eu", tag: "EU" },
    ];
    for (const { toolId, childSid, tag } of tasks) {
      stream.pushToolUse("s1", "actor-a", {
        toolId,
        toolName: `${tag} scan`,
        description: tag,
        params: { subagent_type: "general", prompt: tag },
        toolKind: "other",
      });
      stream.bindChildAcpSession("s1", "actor-a", toolId, childSid);
      stream.subAppendThinking(toolId, "s1", "actor-a", `${tag} thinking`);
      stream.completeToolUse("s1", "actor-a", {
        toolId,
        success: true,
        summary: "done",
        rawOutput: { metadata: { sessionId: childSid } },
      });
    }

    const parentParts = useV2StreamingStore.getState().byKey["s1::actor-a"].parts;
    const merged = mergeSubagentSnapshotsIntoParts(parentParts, "s1", "actor-a");
    for (const { toolId, childSid, tag } of tasks) {
      const taskPart = merged.find(
        (part) => part.type === "tool-call" && part.toolCall?.id === toolId,
      );
      expect(taskPart?.toolCall?.metadata?.childAcpSessionId).toBe(childSid);
      expect(
        taskPart?.toolCall?.metadata?.subagentSnapshot?.some(
          (part) => part.type === "reasoning" && part.text?.includes(tag),
        ),
      ).toBe(true);
    }
  });
});

describe("persistStreamingPartsForReply", () => {
  it("attaches ordered runtime parts to the final reply", async () => {
    const stream = useV2StreamingStore.getState();
    stream.appendOutput("s1", "actor-a", "Before tools.");
    for (const toolId of ["tool-a", "tool-b", "tool-c"]) {
      stream.pushToolUse("s1", "actor-a", {
        toolId,
        toolName: "grep",
        description: `search ${toolId}`,
        params: {},
        toolKind: "search",
      });
      useV2StreamingStore.getState().completeToolUse("s1", "actor-a", {
        toolId,
        success: true,
        summary: `result ${toolId}`,
      });
    }
    useV2StreamingStore.getState().appendOutput("s1", "actor-a", "After tools.");

    const reply = create(MessageSchema, {
      messageId: "reply-final",
      sessionId: "s1",
      senderActorId: "actor-a",
      kind: MessageKind.AGENT_REPLY,
      content: "After tools.",
      turnId: "turn-1",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "actor-a", reply);

    expect(useSessionMessageStore.getState().messages.s1).toBeUndefined();
    const parts = JSON.parse((reply as unknown as { partsJson: string }).partsJson);
    expect(parts.map((part: { type: string }) => part.type)).toEqual([
      "text",
      "tool-call",
      "tool-call",
      "tool-call",
      "text",
    ]);
    expect(parts[0].text).toBe("Before tools.");
    expect(parts[1].toolCall.id).toBe("tool-a");
    expect(parts[1].toolCall.status).toBe("completed");
    expect(parts[4].text).toBe("After tools.");
  });

  it("does not append a duplicate text part when reply.content only differs by whitespace", async () => {
    const stream = useV2StreamingStore.getState();
    stream.appendOutput("s1", "actor-a", "Done.");

    const reply = create(MessageSchema, {
      messageId: "reply-final",
      sessionId: "s1",
      senderActorId: "actor-a",
      kind: MessageKind.AGENT_REPLY,
      content: "Done. ",
      turnId: "turn-1",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "actor-a", reply);
    const parts = JSON.parse((reply as unknown as { partsJson: string }).partsJson);
    expect(parts.filter((part: { type: string }) => part.type === "text")).toHaveLength(1);
    expect(parts[0].text).toBe("Done.");
  });

  it("does not expose stale parts_json before async enrichment resolves", async () => {
    let resolveSetParts: ((value: string) => void) | undefined;
    localCacheMock.setMessageParts.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSetParts = resolve;
        }),
    );

    const stream = useV2StreamingStore.getState();
    stream.pushToolUse("s1", "actor-a", {
      toolId: "tool-a",
      toolName: "bash",
      description: "List processes sorted by CPU",
      params: {
        command: "ps -eo pid,%cpu,%mem,comm -r | head -8",
      },
      toolKind: "execute",
    });
    stream.completeToolUse("s1", "actor-a", {
      toolId: "tool-a",
      success: true,
      summary: "",
    });

    const reply = create(MessageSchema, {
      messageId: "reply-final",
      sessionId: "s1",
      senderActorId: "actor-a",
      kind: MessageKind.AGENT_REPLY,
      content: "已执行 `ps`，按 CPU 排序前 7 个进程如上。",
      turnId: "turn-1",
      createdAt: BigInt(100),
    }) as typeof MessageSchema.$inferOutput & { partsJson?: string };

    const pending = persistStreamingPartsForReply("s1", "actor-a", reply);

    expect(reply.partsJson).toBeUndefined();

    const initialPartsJson = localCacheMock.setMessageParts.mock.calls[0]?.[1] as string;
    const enrichedParts = JSON.parse(initialPartsJson);
    enrichedParts[0].toolCall.result = "PID %CPU COMM\n50369 opencode\n";
    resolveSetParts?.(JSON.stringify(enrichedParts));
    await pending;

    const finalParts = JSON.parse(reply.partsJson ?? "[]");
    expect(finalParts[0].toolCall.result).toBe("PID %CPU COMM\n50369 opencode\n");
  });

  it("uses a frozen stream snapshot after beginPlanningPlaceholder clears byKey", async () => {
    const stream = useV2StreamingStore.getState();
    stream.pushToolUse("s1", "actor-a", {
      toolId: "sleep-tool",
      toolName: "bash",
      description: "Sleep for 30 seconds",
      params: { command: "sleep 30" },
      toolKind: "execute",
    });
    stream.finishSessionActor("s1", "actor-a");

    const snapshotSource = resolveStreamEntryForPersist("s1", "actor-a");
    const streamEntrySnapshot = snapshotSource
      ? cloneStreamEntrySnapshot(snapshotSource)
      : undefined;
    useV2StreamingStore.getState().beginPlanningPlaceholder("s1", "actor-a");

    const reply = create(MessageSchema, {
      messageId: "reply-interrupted",
      sessionId: "s1",
      senderActorId: "actor-a",
      kind: MessageKind.AGENT_REPLY,
      content: "",
      turnId: "turn-interrupted",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "actor-a", reply, [], {
      streamEntrySnapshot,
    });

    const parts = JSON.parse((reply as unknown as { partsJson: string }).partsJson);
    expect(parts).toHaveLength(1);
    expect(parts[0].toolCall.id).toBe("sleep-tool");
    expect(parts[0].toolCall.status).toBe("failed");
    expect(useV2StreamingStore.getState().byKey["s1::actor-a"].parts).toHaveLength(0);
  });
});
