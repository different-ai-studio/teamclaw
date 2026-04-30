import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQuestionActions } from "@/stores/session-questions";
import { sessionDataCache } from "@/stores/session-data-cache";

const mockReplyQuestion = vi.fn();
const mockRejectQuestion = vi.fn();

vi.mock("@/lib/opencode/sdk-client", () => ({
  getOpenCodeClient: () => ({
    replyQuestion: mockReplyQuestion,
    rejectQuestion: mockRejectQuestion,
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    setFocus: vi.fn(),
    unminimize: vi.fn(),
  })),
}));

vi.mock("@/lib/notification-service", () => ({
  notificationService: { send: vi.fn() },
}));

vi.mock("@/lib/build-config", () => ({
  buildConfig: { app: { name: "TeamClaw" } },
}));

const mockStreamingState = {
  streamingMessageId: "msg-1" as string | null,
  clearStreaming: vi.fn(),
};

vi.mock("@/stores/streaming", () => ({
  useStreamingStore: Object.assign(
    (selector: (s: typeof mockStreamingState) => unknown) => selector(mockStreamingState),
    { getState: () => mockStreamingState },
  ),
}));

describe("session-questions", () => {
  let state: Record<string, unknown>;
  let set: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let actions: ReturnType<typeof createQuestionActions>;
  beforeEach(() => {
    vi.clearAllMocks();
    sessionDataCache.clear();

    state = {
      activeSessionId: "sess-1",
      pendingQuestions: [
        {
          questionId: "event-1",
          toolCallId: "tc-1",
          messageId: "msg-1",
          questions: [
            {
              id: "q-1",
              header: "Question",
              question: "Continue?",
              options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
            },
          ],
        },
      ],
      sessions: [
        {
          id: "sess-1",
          title: "Test",
          messages: [
            {
              id: "msg-1",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "question",
                  status: "waiting",
                  arguments: {},
                  questions: [
                    {
                      id: "q-1",
                      header: "Question",
                      question: "Continue?",
                      options: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    sessionDataCache.set("sess-1", {
      todos: [],
      diff: [],
      pendingQuestions: state.pendingQuestions as any,
    });

    set = vi.fn((updater) => {
      if (typeof updater === "function") {
        Object.assign(state, updater(state as any));
      } else {
        Object.assign(state, updater);
      }
    });
    get = vi.fn(() => state);
    actions = createQuestionActions(set, get);
  });

  it("replies to OpenCode questions and clears pending state", async () => {
    await actions.answerQuestion({ "q-1": "yes" });

    expect(mockReplyQuestion).toHaveBeenCalledWith("event-1", [["yes"]]);
    expect((state as any).pendingQuestions).toEqual([]);
    const toolCall = (state as any).sessions[0].messages[0].toolCalls[0];
    expect(toolCall.status).toBe("completed");
  });

  it("submits the selected answer text as-is", async () => {
    await actions.answerQuestion({ "q-1": "cancel" });

    expect(mockReplyQuestion).toHaveBeenCalledWith("event-1", [["cancel"]]);
    expect((state as any).pendingQuestions).toEqual([]);
  });

  it("rejects OpenCode questions when skipped and clears pending state", async () => {
    await actions.skipQuestion("event-1");

    expect(mockRejectQuestion).toHaveBeenCalledWith("event-1");
    expect((state as any).pendingQuestions).toEqual([]);
    const toolCall = (state as any).sessions[0].messages[0].toolCalls[0];
    expect(toolCall.status).toBe("completed");
  });

  it("upgrades child session questions on the active parent session", () => {
    state.activeSessionId = "parent-1";
    state.pendingQuestions = [
      {
        questionId: "",
        toolCallId: "tc-child",
        messageId: "msg-child",
        sessionId: "child-1",
        questions: [
          {
            id: "q-1",
            header: "Child question",
            question: "Continue child task?",
            options: [{ label: "Yes", value: "yes" }],
          },
        ],
      },
    ];
    state.sessions = [
      { id: "parent-1", title: "Parent", messages: [] },
      { id: "child-1", title: "Child", parentID: "parent-1", messages: [] },
    ];
    sessionDataCache.set("parent-1", {
      todos: [],
      diff: [],
      pendingQuestions: state.pendingQuestions as any,
    });

    actions.handleQuestionAsked({
      id: "event-child",
      sessionId: "child-1",
      questions: [
        {
          id: "q-1",
          header: "Child question",
          question: "Continue child task?",
          options: [{ label: "Yes", value: "yes" }],
        },
      ],
      tool: {
        callId: "tc-child",
        messageId: "msg-child",
      },
    });

    expect((state as any).pendingQuestions).toEqual([
      expect.objectContaining({
        questionId: "event-child",
        toolCallId: "tc-child",
        messageId: "msg-child",
        sessionId: "child-1",
      }),
    ]);
    expect(sessionDataCache.get("parent-1")?.pendingQuestions).toEqual([
      expect.objectContaining({
        questionId: "event-child",
        toolCallId: "tc-child",
        sessionId: "child-1",
      }),
    ]);
  });
});
