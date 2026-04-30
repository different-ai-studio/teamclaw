import { getCurrentWindow } from "@tauri-apps/api/window";
import { getOpenCodeClient } from "@/lib/opencode/sdk-client";
import { notificationService } from "@/lib/notification-service";
import { buildConfig } from "@/lib/build-config";
import type {
  QuestionAskedEvent,
} from "@/lib/opencode/sdk-types";
import type {
  ToolCall,
  SessionState,
  PendingQuestionState,
} from "./session-types";
import {
  sessionLookupCache,
  getSessionById,
} from "./session-cache";
import {
  useStreamingStore,
} from "@/stores/streaming";
import { sessionDataCache } from "./session-data-cache";
import {
  addPendingQuestionActivity,
  pendingQuestionActivityKey,
  removePendingQuestionActivity,
  resolveSessionActivityOwner,
} from "@/lib/session-list-activity";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

function isSamePendingQuestion(existing: PendingQuestionState, incoming: PendingQuestionState): boolean {
  if (incoming.questionId && existing.questionId === incoming.questionId) return true;
  if (incoming.toolCallId && existing.toolCallId === incoming.toolCallId) return true;
  return false;
}

function upsertPendingQuestion(
  questions: PendingQuestionState[] | undefined,
  incoming: PendingQuestionState,
): PendingQuestionState[] {
  const existing = questions || [];
  return [
    ...existing.filter((question) => !isSamePendingQuestion(question, incoming)),
    incoming,
  ].slice(-20);
}

export function createQuestionActions(set: SessionSet, get: SessionGet) {
  const clearPendingQuestion = (pendingQuestion: PendingQuestionState) => {
    const { activeSessionId, sessions } = get();
    const toolCallId = pendingQuestion.toolCallId;
    const sessionId = pendingQuestion.sessionId || activeSessionId;
    const ownerSessionId = resolveSessionActivityOwner(sessionId, sessions, activeSessionId);
    const questionKey = pendingQuestionActivityKey(pendingQuestion);

    const cacheSessionIds = Array.from(
      new Set([sessionId, ownerSessionId].filter(Boolean) as string[]),
    );
    for (const cacheSessionId of cacheSessionIds) {
      const cached = sessionDataCache.get(cacheSessionId);
      if (cached) {
        const qs = (cached.pendingQuestions || []).filter(
          (q) => !isSamePendingQuestion(q, pendingQuestion),
        );
        sessionDataCache.set(cacheSessionId, {
          ...cached,
          pendingQuestions: qs,
        });
      }
    }

    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === activeSessionId
          ? {
              ...s,
              messages: s.messages.map((m) => ({
                ...m,
                toolCalls: m.toolCalls?.map((tc) =>
                  tc.id === toolCallId
                    ? { ...tc, status: "completed" as const }
                    : tc,
                ),
              })),
              updatedAt: new Date(),
            }
          : s,
      ),
      pendingQuestions: state.pendingQuestions.filter(
        (q) => !isSamePendingQuestion(q, pendingQuestion),
      ),
      pendingQuestionIdsBySession: removePendingQuestionActivity(
        state.pendingQuestionIdsBySession || {},
        sessionId,
        questionKey,
      ),
    }));
  };

  return {
    // Answer question tool
    answerQuestion: async (answers: Record<string, string>, questionId?: string) => {
      const { pendingQuestions, activeSessionId } = get();
      if (!activeSessionId) return;
      // Find the specific question to answer (by questionId if provided, else first one)
      const pendingQuestion = questionId
        ? pendingQuestions.find((q) => q.questionId === questionId)
        : pendingQuestions[0];
      if (!pendingQuestion) return;
      if (!pendingQuestion.questionId) {
        console.warn("[Question] Cannot submit — questionId not yet set (waiting for question.asked SSE event)");
        return;
      }

      const formattedAnswers = pendingQuestion.questions.map((q, idx) => {
        const qid = q.id || String(idx);
        const answer = answers[qid] || "";
        return [answer];
      });

      try {
        const client = getOpenCodeClient();

        console.log(
          "[Question] Replying to question:",
          pendingQuestion.questionId,
        );
        console.log("[Question] Answers:", formattedAnswers);

        try {
          await client.replyQuestion(
            pendingQuestion.questionId,
            formattedAnswers,
          );
          console.log("[Question] Reply sent successfully");
        } catch (replyError) {
          console.error("[Question] Reply API error:", replyError);
          throw replyError;
        }

        clearPendingQuestion(pendingQuestion);
      } catch (error) {
        useStreamingStore.getState().clearStreaming();
        set((state) => ({
          error:
            error instanceof Error ? error.message : "Failed to answer question",
          pendingQuestions: state.pendingQuestions.filter(
            (q) => !isSamePendingQuestion(q, pendingQuestion),
          ),
        }));
      }
    },

    skipQuestion: async (questionId?: string) => {
      const { pendingQuestions, activeSessionId } = get();
      if (!activeSessionId) return;
      const pendingQuestion = questionId
        ? pendingQuestions.find((q) => q.questionId === questionId)
        : pendingQuestions[0];
      if (!pendingQuestion) return;
      if (!pendingQuestion.questionId) {
        console.warn("[Question] Cannot skip — questionId not yet set (waiting for question.asked SSE event)");
        return;
      }

      try {
        const client = getOpenCodeClient();

        console.log(
          "[Question] Rejecting question:",
          pendingQuestion.questionId,
        );

        try {
          await client.rejectQuestion(pendingQuestion.questionId);
          console.log("[Question] Reject sent successfully");
        } catch (rejectError) {
          console.error("[Question] Reject API error:", rejectError);
          throw rejectError;
        }

        clearPendingQuestion(pendingQuestion);
      } catch (error) {
        useStreamingStore.getState().clearStreaming();
        set((state) => ({
          error:
            error instanceof Error ? error.message : "Failed to skip question",
          pendingQuestions: state.pendingQuestions.filter(
            (q) => !isSamePendingQuestion(q, pendingQuestion),
          ),
        }));
      }
    },

    setPendingQuestion: (question: PendingQuestionState | null) => {
      if (question === null) {
        // Clear all pending questions (legacy behavior)
        set({ pendingQuestions: [] });
      } else {
        set((state) => ({
          pendingQuestions: upsertPendingQuestion(state.pendingQuestions, question),
          pendingQuestionIdsBySession: addPendingQuestionActivity(
            state.pendingQuestionIdsBySession || {},
            question.sessionId || state.activeSessionId,
            pendingQuestionActivityKey(question),
          ),
        }));
      }
    },

    // Handle question.asked SSE event
    handleQuestionAsked: (event: QuestionAskedEvent) => {
      const {
        activeSessionId,
        pendingQuestions,
        sessions: currentSessions,
        setActiveSession: navigateToSession,
      } = get();
      const { streamingMessageId } = useStreamingStore.getState();
      const ownerSessionId = resolveSessionActivityOwner(event.sessionId, currentSessions, event.sessionId);

      const existing =
        pendingQuestions.find((q) => q.toolCallId === event.tool?.callId) ||
        sessionDataCache.get(event.sessionId)?.pendingQuestions?.find((q) => q.toolCallId === event.tool?.callId) ||
        (ownerSessionId ? sessionDataCache.get(ownerSessionId)?.pendingQuestions?.find((q) => q.toolCallId === event.tool?.callId) : undefined) ||
        null;

      console.log("[Session] Question asked:", event.id);

      // Send notification for questions
      {
        const session = currentSessions.find((s) => s.id === event.sessionId);
        const sessionTitle = session?.title || "Session";

        notificationService.send(
          "action_required",
          `${buildConfig.app.name} - \u9700\u8981\u56de\u7b54`,
          `${sessionTitle} \u2014 AI \u6709\u95ee\u9898\u9700\u8981\u4f60\u56de\u7b54`,
          event.sessionId,
          async () => {
            try {
              await navigateToSession(event.sessionId);
              const appWindow = getCurrentWindow();
              await appWindow.setFocus();
              await appWindow.unminimize();
            } catch {
              // Ignore focus errors
            }
          },
        );
      }

      const questionData: PendingQuestionState = {
        questionId: event.id,
        toolCallId: event.tool?.callId || existing?.toolCallId || event.id,
        messageId:
          event.tool?.messageId ||
          existing?.messageId ||
          streamingMessageId ||
          "",
        questions: event.questions || existing?.questions || [],
        sessionId: event.sessionId,
        source: "opencode" as const,
      };

      const cacheQuestion = (sessionId: string | null | undefined) => {
        if (!sessionId) return;
        const cached = sessionDataCache.get(sessionId) || { todos: [], diff: [] };
        sessionDataCache.set(sessionId, {
          ...cached,
          pendingQuestions: upsertPendingQuestion(cached.pendingQuestions, questionData),
        });
      };

      cacheQuestion(event.sessionId);
      if (ownerSessionId !== event.sessionId) {
        cacheQuestion(ownerSessionId);
      }

      if (ownerSessionId !== activeSessionId) {
        set((state) => ({
          pendingQuestionIdsBySession: addPendingQuestionActivity(
            state.pendingQuestionIdsBySession || {},
            event.sessionId,
            pendingQuestionActivityKey(questionData),
          ),
        }));
        return;
      }

      set((state) => ({
        pendingQuestions: upsertPendingQuestion(state.pendingQuestions, questionData),
        pendingQuestionIdsBySession: addPendingQuestionActivity(
          state.pendingQuestionIdsBySession || {},
          event.sessionId,
          pendingQuestionActivityKey(questionData),
        ),
      }));

      // If we have tool info, also update the tool call in the message
      if (event.tool && streamingMessageId) {
        set((state) => {
          const session = activeSessionId ? getSessionById(activeSessionId) : null;
          if (!session) return state;

          const msgIndex = session.messages.findIndex((m) => m.id === streamingMessageId);
          if (msgIndex === -1) return state;

          const m = session.messages[msgIndex];

          const existingTool = m.toolCalls?.find(
            (tc) => tc.id === event.tool!.callId,
          );

          let updatedMessage;
          if (existingTool) {
            updatedMessage = {
              ...m,
              toolCalls: m.toolCalls?.map((tc) =>
                tc.id === event.tool!.callId
                  ? {
                      ...tc,
                      questions: event.questions,
                      status: "waiting" as const,
                    }
                  : tc,
              ),
            };
          } else {
            const newToolCall: ToolCall = {
              id: event.tool!.callId,
              name: "question",
              status: "waiting",
              arguments: { questions: event.questions },
              startTime: new Date(),
              questions: event.questions,
            };
            updatedMessage = {
              ...m,
              toolCalls: [...(m.toolCalls || []), newToolCall],
            };
          }

          const newMessages = [...session.messages];
          newMessages[msgIndex] = updatedMessage;
          const newSession = { ...session, messages: newMessages };

          sessionLookupCache.set(session.id, newSession);

          return {
            sessions: state.sessions.map((s) =>
              s.id === session.id ? newSession : s,
            ),
          };
        });
      }
    },
  };
}
