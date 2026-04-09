import { getOpenCodeClient } from "@/lib/opencode/sdk-client";
import type {
  ToolExecutingEvent,
  QuestionToolInput,
  Question,
  FileDiff,
  TodoUpdatedEvent,
  SessionDiffEvent,
} from "@/lib/opencode/sdk-types";
import type {
  SessionState,
  ToolCall,
} from "./session-types";
import {
  sessionLookupCache,
  getSessionById,
} from "./session-cache";
import {
  externalReloadingSessions,
  pendingPermissionBuffer,
} from "./session-internals";
import {
  useStreamingStore,
} from "@/stores/streaming";
import { sessionDataCache } from "./session-data-cache";
import {
  buildTerminalInputQuestion,
  extractTerminalPromptSnippet,
  getCommandText,
  getTerminalPromptKind,
  getToolCallOutputText,
  isLikelyTerminalPromptText,
} from "@/lib/terminal-interaction";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

export function createToolHandlers(set: SessionSet, get: SessionGet) {
  return {
    handleToolExecuting: (event: ToolExecutingEvent) => {
      const { activeSessionId } = get();
      const { streamingMessageId } = useStreamingStore.getState();
      if (!streamingMessageId) return;
      if (activeSessionId && externalReloadingSessions.has(activeSessionId)) return;

      if (event.sessionId && event.sessionId !== activeSessionId) {
        console.log("[Session] Ignoring tool event for different session:", event.sessionId, "active:", activeSessionId);
        return;
      }
      if (event.messageId && event.messageId !== streamingMessageId) {
        console.log("[Session] Ignoring tool event for different message:", event.messageId, "streaming:", streamingMessageId);
        return;
      }

      const mapStatus = (
        status: string,
      ): "calling" | "completed" | "failed" | "waiting" => {
        if (status === "completed") return "completed";
        if (status === "failed") return "failed";
        if (status === "running") return "calling";
        return "waiting";
      };

      const isQuestionTool = event.toolName.toLowerCase() === "question";
      const isRunning = event.status === "running";
      const toolNameLower = event.toolName.toLowerCase();
      const isCommandTool =
        toolNameLower.includes("bash") ||
        toolNameLower.includes("shell") ||
        toolNameLower.includes("terminal") ||
        toolNameLower.includes("run_command");
      const commandText = getCommandText(event.arguments);
      const outputText = getToolCallOutputText(event.result);
      const needsTerminalInput =
        isCommandTool &&
        isRunning &&
        isLikelyTerminalPromptText(outputText);

      let questions: Question[] | undefined;
      if (isQuestionTool && event.arguments) {
        const args = event.arguments as unknown as QuestionToolInput;
        if (args.questions && Array.isArray(args.questions)) {
          questions = args.questions;
        }
      }

      if (needsTerminalInput) {
        const promptSnippet = extractTerminalPromptSnippet(outputText);
        questions = [buildTerminalInputQuestion(commandText, outputText)];

        const questionData = {
          questionId: `terminal-input:${event.toolCallId}`,
          toolCallId: event.toolCallId,
          messageId: streamingMessageId,
          questions,
          sessionId: event.sessionId ?? activeSessionId ?? undefined,
          source: "terminal_input" as const,
          terminalInputContext: {
            command: commandText,
            prompt: promptSnippet,
            kind: getTerminalPromptKind(promptSnippet),
          },
        };

        const existingQuestions = get().pendingQuestions;
        const existingForTool = existingQuestions.find((q) => q.toolCallId === event.toolCallId);
        if (
          !existingForTool ||
          existingForTool.source !== "opencode"
        ) {
          set((state) => ({
            pendingQuestions: [
              ...state.pendingQuestions.filter((q) => q.toolCallId !== event.toolCallId),
              questionData,
            ].slice(-20),
          }));
          if (activeSessionId) {
            const cached = sessionDataCache.get(activeSessionId) || { todos: [], diff: [] };
            const cacheQuestions = cached.pendingQuestions || [];
            sessionDataCache.set(activeSessionId, {
              ...cached,
              pendingQuestions: [
                ...cacheQuestions.filter((q) => q.toolCallId !== event.toolCallId),
                questionData,
              ],
            });
          }
        }
      } else if (
        get().pendingQuestions.some(
          (q) => q.source === "terminal_input" && q.toolCallId === event.toolCallId,
        ) &&
        event.status !== "running"
      ) {
        set((state) => ({
          pendingQuestions: state.pendingQuestions.filter((q) => q.toolCallId !== event.toolCallId),
        }));
        if (activeSessionId) {
          const cached = sessionDataCache.get(activeSessionId);
          if (cached) {
            const cacheQs = cached.pendingQuestions || [];
            sessionDataCache.set(activeSessionId, {
              ...cached,
              pendingQuestions: cacheQs.filter((q) => q.toolCallId !== event.toolCallId),
            });
          }
        }
      }

      if (isQuestionTool && isRunning && questions && questions.length > 0) {
        const existingForThisTool = get().pendingQuestions.find((q) => q.toolCallId === event.toolCallId);
        if (!existingForThisTool || !existingForThisTool.questionId) {
          // Pre-populate with tool/message info and questions, but leave questionId empty.
          // The real questionId arrives via handleQuestionAsked (question.asked SSE event).
          // We still set pendingQuestions so the QuestionCard renders, but answerQuestion
          // won't submit until questionId is non-empty (see guard below).
          const questionData = {
            questionId: "",
            toolCallId: event.toolCallId,
            messageId: streamingMessageId,
            questions,
            sessionId: event.sessionId ?? activeSessionId ?? undefined,
          };
          set((state) => ({
            pendingQuestions: [
              ...state.pendingQuestions.filter((q) => q.toolCallId !== event.toolCallId),
              questionData,
            ].slice(-20),
          }));
          // Also save to cache so it survives session switching
          if (activeSessionId) {
            const cached = sessionDataCache.get(activeSessionId) || { todos: [], diff: [] };
            const cacheQuestions = cached.pendingQuestions || [];
            sessionDataCache.set(activeSessionId, {
              ...cached,
              pendingQuestions: [
                ...cacheQuestions.filter((q) => q.toolCallId !== event.toolCallId),
                questionData,
              ],
            });
          }
        }
      }

      if (isQuestionTool && event.status === "completed") {
        set((state) => ({
          pendingQuestions: state.pendingQuestions.filter((q) => q.toolCallId !== event.toolCallId),
        }));
        // Also clear from cache
        if (activeSessionId) {
          const cached = sessionDataCache.get(activeSessionId);
          if (cached) {
            const cacheQsComplete = cached.pendingQuestions || [];
            sessionDataCache.set(activeSessionId, {
              ...cached,
              pendingQuestions: cacheQsComplete.filter((q) => q.toolCallId !== event.toolCallId),
            });
          }
        }
      }

      const currentActiveSessionId = get().activeSessionId;
      set((state) => {
        const session = currentActiveSessionId ? getSessionById(currentActiveSessionId) : null;
        if (!session) return state;

        const msgIndex = session.messages.findIndex((m) => m.id === streamingMessageId);
        if (msgIndex === -1) return state;

        const m = session.messages[msgIndex];
        let updatedMessage;

        const existingTool = m.toolCalls?.find(
          (tc) => tc.id === event.toolCallId,
        );

        if (existingTool) {
          const newStatus = needsTerminalInput
            ? "waiting"
            : mapStatus(event.status);
          updatedMessage = {
            ...m,
            toolCalls: m.toolCalls?.map((tc) =>
              tc.id === event.toolCallId
                ? {
                    ...tc,
                    status: newStatus,
                    arguments:
                      event.arguments &&
                      Object.keys(event.arguments).length > 0
                        ? event.arguments
                        : tc.arguments,
                    result: event.result || tc.result,
                    duration:
                      event.duration ||
                      (newStatus === "completed" && tc.startTime
                        ? Date.now() - tc.startTime.getTime()
                        : tc.duration),
                    questions:
                      questions ||
                      (event.status === "completed" || event.status === "failed"
                        ? undefined
                        : tc.questions),
                    metadata: event.metadata || tc.metadata,
                  }
                : tc,
            ),
          };
        } else {
          const bufferedPerm = pendingPermissionBuffer.get(event.toolCallId);
          const newToolCall: ToolCall = {
            id: event.toolCallId,
            name: event.toolName,
            status: needsTerminalInput ? "waiting" : mapStatus(event.status),
            arguments: event.arguments || {},
            result: event.result,
            duration: event.duration,
            startTime: new Date(),
            questions,
            metadata: event.metadata,
            permission: bufferedPerm
              ? {
                  id: bufferedPerm.id,
                  permission: bufferedPerm.permission,
                  patterns: bufferedPerm.patterns,
                  metadata: bufferedPerm.metadata,
                  always: bufferedPerm.always,
                  decision: "pending",
                }
              : undefined,
          };
          if (bufferedPerm) {
            pendingPermissionBuffer.delete(event.toolCallId);
          }
          updatedMessage = {
            ...m,
            toolCalls: [...(m.toolCalls || []), newToolCall],
          };
        }

        const messages = [...session.messages];
        messages[msgIndex] = updatedMessage;
        const newSession = { ...session, messages };

        sessionLookupCache.set(currentActiveSessionId!, newSession);

        return {
          sessions: state.sessions.map((s) =>
            s.id === currentActiveSessionId ? newSession : s,
          ),
        };
      });
    },

    forceCompleteToolCall: (toolCallId: string) => {
      set((state) => ({
        sessions: state.sessions.map((s) => ({
          ...s,
          messages: s.messages.map((m) => ({
            ...m,
            toolCalls: m.toolCalls?.map((tc) =>
              tc.id === toolCallId && tc.status === "calling"
                ? {
                    ...tc,
                    status: "completed" as const,
                    duration: tc.startTime
                      ? Date.now() - tc.startTime.getTime()
                      : tc.duration,
                  }
                : tc,
            ),
          })),
        })),
      }));
    },

    // Handle todo.updated SSE event
    handleTodoUpdated: (event: TodoUpdatedEvent) => {
      const { activeSessionId } = get();
      if (event.sessionId !== activeSessionId) return;

      console.log("[Session] Todo updated:", event.todos.length, "items");
      set({ todos: event.todos });

      const cached = sessionDataCache.get(event.sessionId) || {
        todos: [],
        diff: [],
      };
      sessionDataCache.set(event.sessionId, { ...cached, todos: event.todos });
    },

    // Handle session.diff SSE event
    handleSessionDiff: (event: SessionDiffEvent) => {
      const { activeSessionId } = get();
      if (event.sessionId !== activeSessionId) return;

      console.log("[Session] Session diff:", event.diff.length, "files");
      set({ sessionDiff: event.diff });

      const cached = sessionDataCache.get(event.sessionId) || {
        todos: [],
        diff: [],
      };
      sessionDataCache.set(event.sessionId, { ...cached, diff: event.diff });
    },

    // Handle file.edited SSE event - refresh diffs
    handleFileEdited: (file: string) => {
      console.log("[Session] File edited:", file);
      get().refreshSessionDiff();
    },

    // Refresh session diffs from API
    refreshSessionDiff: async () => {
      const { activeSessionId } = get();
      if (!activeSessionId) return;

      try {
        const client = getOpenCodeClient();

        const diffsData = await client
          .getSessionDiff(activeSessionId)
          .catch(() => []);

        console.log("[Session] Refresh - session diff:", diffsData.length);

        const diffs: FileDiff[] = diffsData.map((d) => ({
          file: d.file,
          before: d.before || "",
          after: d.after || "",
          additions: d.additions || 0,
          deletions: d.deletions || 0,
        }));

        console.log("[Session] Refreshed diffs:", diffs.length, "files");
        set({ sessionDiff: diffs });

        const cached = sessionDataCache.get(activeSessionId) || {
          todos: [],
          diff: [],
        };
        sessionDataCache.set(activeSessionId, { ...cached, diff: diffs });
      } catch (error) {
        console.error("[Session] Failed to refresh diffs:", error);
      }
    },
  };
}
