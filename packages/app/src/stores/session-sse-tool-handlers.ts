import { getOpenCodeClient } from "@/lib/opencode/client";
import type {
  ToolExecutingEvent,
  QuestionToolInput,
  Question,
  FileDiff,
  TodoUpdatedEvent,
  SessionDiffEvent,
} from "@/lib/opencode/types";
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

      let questions: Question[] | undefined;
      if (isQuestionTool && event.arguments) {
        const args = event.arguments as unknown as QuestionToolInput;
        if (args.questions && Array.isArray(args.questions)) {
          questions = args.questions;
        }
      }

      if (isQuestionTool && isRunning && questions && questions.length > 0) {
        const existing = get().pendingQuestion;
        if (!existing || !existing.questionId) {
          const questionData = {
            questionId: existing?.questionId || "",
            toolCallId: event.toolCallId,
            messageId: streamingMessageId,
            questions,
          };
          set({ pendingQuestion: questionData });
          // Also save to cache so it survives session switching
          if (activeSessionId) {
            const cached = sessionDataCache.get(activeSessionId) || { todos: [], diff: [] };
            sessionDataCache.set(activeSessionId, { ...cached, pendingQuestion: questionData });
          }
        }
      }

      if (isQuestionTool && event.status === "completed") {
        set({ pendingQuestion: null });
        // Also clear from cache
        if (activeSessionId) {
          const cached = sessionDataCache.get(activeSessionId);
          if (cached) {
            sessionDataCache.set(activeSessionId, { ...cached, pendingQuestion: null });
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
          const newStatus = mapStatus(event.status);
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
                    questions: questions || tc.questions,
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
            status: mapStatus(event.status),
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
