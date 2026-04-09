import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQuestionActions } from "@/stores/session-questions";
import { sessionDataCache } from "@/stores/session-data-cache";

const mockReplyQuestion = vi.fn();

vi.mock("@/lib/opencode/sdk-client", () => ({
  getOpenCodeClient: () => ({
    replyQuestion: mockReplyQuestion,
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
  let abortSession: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionDataCache.clear();

    abortSession = vi.fn().mockResolvedValue(undefined);
    sendMessage = vi.fn().mockResolvedValue(undefined);

    state = {
      activeSessionId: "sess-1",
      pendingQuestions: [
        {
          questionId: "terminal-input:tc-1",
          toolCallId: "tc-1",
          messageId: "msg-1",
          source: "terminal_input",
          terminalInputContext: {
            command: "rm -rf build",
            prompt: "Continue? [y/N]",
            kind: "confirm",
          },
          questions: [
            {
              id: "terminal-input",
              header: "Terminal Input",
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
                  name: "bash",
                  status: "waiting",
                  arguments: { command: "rm -rf build" },
                  questions: [
                    {
                      id: "terminal-input",
                      header: "Terminal Input",
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
      abortSession,
      sendMessage,
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

  it("aborts the stuck run and sends a follow-up message for synthetic terminal questions", async () => {
    await actions.answerQuestion({ "terminal-input": "yes" });

    expect(abortSession).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toContain("User wants this response: `yes`");
    expect(sendMessage.mock.calls[0][0]).toContain("rm -rf build");
    expect((state as any).pendingQuestions).toEqual([]);
    expect(mockReplyQuestion).not.toHaveBeenCalled();
  });

  it("aborts and clears state without sending follow-up when user cancels", async () => {
    await actions.answerQuestion({ "terminal-input": "cancel" });

    expect(abortSession).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((state as any).pendingQuestions).toEqual([]);
    expect(mockReplyQuestion).not.toHaveBeenCalled();
  });
});
