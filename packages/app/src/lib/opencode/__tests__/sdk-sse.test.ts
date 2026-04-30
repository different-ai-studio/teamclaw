import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllChildSessions,
  OpenCodeSSE,
  registerChildSession,
} from "@/lib/opencode/sdk-sse";

describe("OpenCodeSSE", () => {
  beforeEach(() => {
    clearAllChildSessions();
  });

  it("routes child session question events to the question handler", () => {
    const onQuestionAsked = vi.fn();
    const onChildSessionEvent = vi.fn();
    const sse = new OpenCodeSSE("http://localhost:13141", "parent-session", {
      onQuestionAsked,
      onChildSessionEvent,
    });

    registerChildSession("child-session");

    (sse as unknown as { handleEvent: (event: unknown) => void }).handleEvent({
      type: "question.asked",
      properties: {
        id: "question-1",
        sessionID: "child-session",
        questions: [
          {
            question: "Pick one",
            options: [{ label: "A" }],
          },
        ],
        tool: {
          callID: "tool-1",
          messageID: "message-1",
        },
      },
    });

    expect(onQuestionAsked).toHaveBeenCalledWith({
      id: "question-1",
      sessionId: "child-session",
      questions: [
        {
          question: "Pick one",
          options: [{ label: "A" }],
        },
      ],
      tool: {
        callId: "tool-1",
        messageId: "message-1",
      },
    });
    expect(onChildSessionEvent).not.toHaveBeenCalled();
  });
});
