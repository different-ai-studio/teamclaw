import { describe, expect, it } from "vitest";
import { convertMessage } from "@/stores/session-converters";
import type { Message as OpenCodeMessage } from "@/lib/opencode/sdk-types";

function makeOpenCodeMessage(
  overrides: Partial<OpenCodeMessage> = {},
): OpenCodeMessage {
  return {
    info: {
      id: "msg-1",
      sessionID: "sess-1",
      role: "user",
      time: { created: 1 },
    },
    parts: [],
    ...overrides,
  } as OpenCodeMessage;
}

describe("convertMessage", () => {
  it("marks OpenCode compaction user messages for dedicated rendering", () => {
    const converted = convertMessage(
      makeOpenCodeMessage({
        info: {
          id: "msg-compaction",
          sessionID: "sess-1",
          role: "user",
          agent: "build",
          time: { created: 1 },
        },
        parts: [
          {
            id: "part-compaction",
            sessionID: "sess-1",
            messageID: "msg-compaction",
            type: "compaction",
            auto: true,
            overflow: true,
          },
        ],
      } as unknown as Partial<OpenCodeMessage>),
    );

    expect(converted.content).toBe("");
    expect(converted.displayKind).toBe("compaction");
    expect(converted.compaction).toEqual({
      auto: true,
      overflow: true,
      completed: true,
    });
  });

  it("hides OpenCode compaction summary assistant messages", () => {
    const converted = convertMessage(
      makeOpenCodeMessage({
        info: {
          id: "msg-summary",
          sessionID: "sess-1",
          role: "assistant",
          parentID: "msg-compaction",
          mode: "compaction",
          agent: "compaction",
          summary: true,
          time: { created: 2, completed: 3 },
        },
        parts: [{ id: "part-text", sessionID: "sess-1", messageID: "msg-summary", type: "text", text: "summary" }],
      } as unknown as Partial<OpenCodeMessage>),
    );

    expect(converted.displayKind).toBe("compaction-summary");
    expect(converted.hidden).toBe(true);
    expect(converted.parentID).toBe("msg-compaction");
  });

  it("hides explicit synthetic compaction continue user messages", () => {
    const converted = convertMessage(
      makeOpenCodeMessage({
        info: {
          id: "msg-synthetic",
          sessionID: "sess-1",
          role: "user",
          synthetic: true,
          metadata: { compaction_continue: true },
          time: { created: 4 },
        },
        parts: [
          { id: "part-text", sessionID: "sess-1", messageID: "msg-synthetic", type: "text", text: "repeat visible user text" },
        ],
      } as unknown as Partial<OpenCodeMessage>),
    );

    expect(converted.displayKind).toBe("synthetic");
    expect(converted.hidden).toBe(true);
    expect(converted.content).toBe("");
  });

  it("keeps regular synthetic user text visible when it is not a compaction marker", () => {
    const converted = convertMessage(
      makeOpenCodeMessage({
        info: {
          id: "msg-synthetic-regular",
          sessionID: "sess-1",
          role: "user",
          synthetic: true,
          time: { created: 5 },
        },
        parts: [
          { id: "part-text", sessionID: "sess-1", messageID: "msg-synthetic-regular", type: "text", text: "regular synthetic text" },
        ],
      } as unknown as Partial<OpenCodeMessage>),
    );

    expect(converted.displayKind).toBeUndefined();
    expect(converted.hidden).toBeUndefined();
    expect(converted.content).toBe("regular synthetic text");
  });
});
