import { describe, expect, it } from "vitest";
import {
  extractTaskChildBinding,
  findCallingTaskToolId,
  isTaskToolCall,
} from "@/lib/teamclaw/subagent-acp-binding";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";

describe("extractTaskChildBinding", () => {
  it("parses sessionId and parentSessionId from rawOutput metadata", () => {
    expect(
      extractTaskChildBinding({
        metadata: {
          sessionId: "ses_child",
          parentSessionId: "ses_root",
        },
      }),
    ).toEqual({
      childAcpSessionId: "ses_child",
      parentAcpSessionId: "ses_root",
    });
  });

  it("returns null when metadata is missing", () => {
    expect(extractTaskChildBinding({})).toBeNull();
    expect(extractTaskChildBinding(null)).toBeNull();
  });
});

describe("isTaskToolCall", () => {
  it("detects task after title rename via subagent args", () => {
    expect(
      isTaskToolCall({
        name: "Run ps command",
        arguments: { subagent_type: "general", prompt: "run ps" },
      }),
    ).toBe(true);
  });
});

describe("findCallingTaskToolId", () => {
  it("finds calling task tool by id", () => {
    const entry: AgentStreamEntry = {
      sessionId: "s1",
      actorId: "a1",
      outputText: "",
      thinkingText: "",
      parts: [],
      toolCalls: [
        {
          id: "task-1",
          name: "Run ps command",
          status: "calling",
          arguments: { subagent_type: "general" },
          startTime: new Date(),
        },
      ],
      planEntries: [],
      pendingPermissionsByRequestId: {},
      errorMessage: null,
      errorDetails: null,
      lastUpdate: 0,
      active: true,
      streamId: "s1",
    };
    expect(findCallingTaskToolId("s1", "a1", { "s1::a1": entry })).toBe("task-1");
  });
});
