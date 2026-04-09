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
  buildTerminalInputFollowUpMessage,
  isTerminalCancelAnswer,
  isSyntheticTerminalQuestionId,
} from "@/lib/terminal-interaction";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

export function createQuestionActions(set: SessionSet, get: SessionGet) {
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

        if (
          pendingQuestion.source === "terminal_input" ||
          isSyntheticTerminalQuestionId(pendingQuestion.questionId)
        ) {
          const answerText = formattedAnswers.flat().join("; ").trim();
          const streamingMessageId = useStreamingStore.getState().streamingMessageId;

          if (streamingMessageId) {
            await get().abortSession();
          }

          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === activeSessionId
                ? {
                    ...s,
                    messages: s.messages.map((m) => ({
                      ...m,
                      toolCalls: m.toolCalls?.map((tc) =>
                        tc.id === pendingQuestion.toolCallId
                          ? {
                              ...tc,
                              status: "failed" as const,
                              questions: undefined,
                            }
                          : tc,
                      ),
                    })),
                    updatedAt: new Date(),
                  }
                : s,
            ),
            pendingQuestions: state.pendingQuestions.filter(
              (q) => q.questionId !== pendingQuestion.questionId,
            ),
          }));

          if (activeSessionId) {
            const cached = sessionDataCache.get(activeSessionId);
            if (cached) {
              const qs = (cached.pendingQuestions || []).filter(
                (q) => q.questionId !== pendingQuestion.questionId,
              );
              sessionDataCache.set(activeSessionId, {
                ...cached,
                pendingQuestions: qs,
              });
            }
          }

          if (isTerminalCancelAnswer(answerText)) {
            return;
          }

          const followUp = buildTerminalInputFollowUpMessage({
            command: pendingQuestion.terminalInputContext?.command || "",
            prompt: pendingQuestion.terminalInputContext?.prompt || "",
            answer: answerText,
            kind: pendingQuestion.terminalInputContext?.kind || "generic",
          });

          await get().sendMessage(followUp);
          return;
        }

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

        const toolCallId = pendingQuestion.toolCallId;

        // Clear this pending question from both state and cache
        if (activeSessionId) {
          const cached = sessionDataCache.get(activeSessionId);
          if (cached) {
            const qs = (cached.pendingQuestions || []).filter(
              (q) => q.questionId !== pendingQuestion.questionId,
            );
            sessionDataCache.set(activeSessionId, {
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
            (q) => q.questionId !== pendingQuestion.questionId,
          ),
        }));
      } catch (error) {
        useStreamingStore.getState().clearStreaming();
        set((state) => ({
          error:
            error instanceof Error ? error.message : "Failed to answer question",
          pendingQuestions: state.pendingQuestions.filter(
            (q) => q.questionId !== pendingQuestion.questionId,
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
          pendingQuestions: [
            ...state.pendingQuestions.filter((q) => q.questionId !== question.questionId),
            question,
          ].slice(-20),
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

      const existing =
        pendingQuestions.find((q) => q.toolCallId === event.tool?.callId) || null;

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

      if (event.sessionId !== activeSessionId) {
        // Cache the question for non-active sessions so it's restored on switch
        const cached = sessionDataCache.get(event.sessionId) || { todos: [], diff: [] };
        const existingQuestions = cached.pendingQuestions || [];
        sessionDataCache.set(event.sessionId, {
          ...cached,
          pendingQuestions: [
            ...existingQuestions.filter((q) => q.questionId !== questionData.questionId),
            questionData,
          ],
        });
        return;
      }

      set((state) => ({
        pendingQuestions: [
          ...state.pendingQuestions.filter((q) => q.questionId !== questionData.questionId),
          questionData,
        ].slice(-20),
      }));

      // Also save to cache so it survives session switching
      const cachedActive = sessionDataCache.get(activeSessionId!) || { todos: [], diff: [] };
      const activeQuestions = cachedActive.pendingQuestions || [];
      sessionDataCache.set(activeSessionId!, {
        ...cachedActive,
        pendingQuestions: [
          ...activeQuestions.filter((q) => q.questionId !== questionData.questionId),
          questionData,
        ],
      });

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
