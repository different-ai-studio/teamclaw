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
import { useLocalStatsStore } from "@/stores/local-stats";
import { useWorkspaceStore } from "@/stores/workspace";
import { sessionDataCache } from "./session-data-cache";
import {
  addPendingQuestionActivity,
  pendingQuestionActivityKey,
  removePendingQuestionActivity,
  resolveSessionActivityOwner,
} from "@/lib/session-list-activity";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

// Tracks toolCallIds already counted for skill telemetry so a single invocation
// is counted exactly once, even though handleToolExecuting fires multiple times
// (status: running → completed, and the first event often has empty args).
const countedSkillToolCalls = new Set<string>();

// Cap the set so it can't grow unbounded in a long-lived session.
function markSkillCounted(toolCallId: string) {
  if (countedSkillToolCalls.size > 10_000) {
    countedSkillToolCalls.clear();
  }
  countedSkillToolCalls.add(toolCallId);
}

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

      let questions: Question[] | undefined;
      if (isQuestionTool && event.arguments) {
        const args = event.arguments as unknown as QuestionToolInput;
        if (args.questions && Array.isArray(args.questions)) {
          questions = args.questions;
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
          const ownerSessionId = resolveSessionActivityOwner(
            questionData.sessionId,
            get().sessions,
            activeSessionId,
          );
          set((state) => ({
            pendingQuestions:
              ownerSessionId === state.activeSessionId
                ? [
                    ...state.pendingQuestions.filter((q) => q.toolCallId !== event.toolCallId),
                    questionData,
                  ].slice(-20)
                : state.pendingQuestions,
            pendingQuestionIdsBySession: addPendingQuestionActivity(
              state.pendingQuestionIdsBySession || {},
              questionData.sessionId,
              pendingQuestionActivityKey(questionData),
            ),
          }));
          // Also save to cache so it survives session switching
          const cacheSessionIds = Array.from(
            new Set([questionData.sessionId, ownerSessionId].filter(Boolean) as string[]),
          );
          for (const cacheSessionId of cacheSessionIds) {
            const cached = sessionDataCache.get(cacheSessionId) || { todos: [], diff: [] };
            const cacheQuestions = cached.pendingQuestions || [];
            sessionDataCache.set(cacheSessionId, {
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
          pendingQuestionIdsBySession: removePendingQuestionActivity(
            state.pendingQuestionIdsBySession || {},
            event.sessionId ?? activeSessionId,
            event.toolCallId,
          ),
        }));
        // Also clear from cache
        const ownerSessionId = resolveSessionActivityOwner(
          event.sessionId ?? activeSessionId,
          get().sessions,
          activeSessionId,
        );
        const cacheSessionIds = Array.from(
          new Set([event.sessionId ?? activeSessionId, ownerSessionId].filter(Boolean) as string[]),
        );
        for (const cacheSessionId of cacheSessionIds) {
          const cached = sessionDataCache.get(cacheSessionId);
          if (cached) {
            const cacheQsComplete = cached.pendingQuestions || [];
            sessionDataCache.set(cacheSessionId, {
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

      // Skill usage telemetry — fire-and-forget, never blocks streaming.
      // handleToolExecuting fires multiple times per tool (running → completed);
      // the first fire often has empty args, a later fire carries the name.
      // We fire as soon as the name is populated and dedupe by toolCallId so
      // each invocation is counted exactly once, regardless of final status.
      if (
        (toolNameLower === "skill" || toolNameLower === "role_skill") &&
        !countedSkillToolCalls.has(event.toolCallId)
      ) {
        const args = event.arguments as
          | { name?: unknown; skill?: unknown; skill_name?: unknown }
          | undefined;
        const rawName = args?.name ?? args?.skill ?? args?.skill_name;
        const skillName = typeof rawName === "string" ? rawName : undefined;
        if (skillName) {
          const workspacePath = useWorkspaceStore.getState().workspacePath;
          if (workspacePath) {
            markSkillCounted(event.toolCallId);
            void useLocalStatsStore
              .getState()
              .incrementSkillUsage(workspacePath, skillName);
          }
        }
      }
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
