import { getCurrentWindow } from "@tauri-apps/api/window";
import { getOpenCodeClient } from "@/lib/opencode/client";
import { notificationService } from "@/lib/notification-service";
import { buildConfig } from "@/lib/build-config";
import type {
  QuestionAskedEvent,
} from "@/lib/opencode/types";
import type {
  ToolCall,
  SessionState,
} from "./session-types";
import {
  sessionLookupCache,
  getSessionById,
} from "./session-cache";
import {
  useStreamingStore,
} from "@/stores/streaming";
import { sessionDataCache } from "./session-data-cache";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

export function createQuestionActions(set: SessionSet, get: SessionGet) {
  return {
    // Answer question tool
    answerQuestion: async (answers: Record<string, string>) => {
      const { pendingQuestion, activeSessionId } = get();
      if (!pendingQuestion || !activeSessionId) return;

      const formattedAnswers = pendingQuestion.questions.map((q, idx) => {
        const questionId = q.id || String(idx);
        const answer = answers[questionId] || "";
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

        const toolCallId = pendingQuestion.toolCallId;

        // Clear pendingQuestion from both state and cache
        if (activeSessionId) {
          const cached = sessionDataCache.get(activeSessionId);
          if (cached) {
            sessionDataCache.set(activeSessionId, { ...cached, pendingQuestion: null });
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
          pendingQuestion: null,
        }));
      } catch (error) {
        useStreamingStore.getState().clearStreaming();
        set({
          error:
            error instanceof Error ? error.message : "Failed to answer question",
          pendingQuestion: null,
        });
      }
    },

    setPendingQuestion: (question: SessionState["pendingQuestion"]) => {
      set({ pendingQuestion: question });
    },

    // Handle question.asked SSE event
    handleQuestionAsked: (event: QuestionAskedEvent) => {
      const {
        activeSessionId,
        pendingQuestion: existing,
        sessions: currentSessions,
        setActiveSession: navigateToSession,
      } = get();
      const { streamingMessageId } = useStreamingStore.getState();

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

      const questionData = {
        questionId: event.id,
        toolCallId: event.tool?.callId || existing?.toolCallId || event.id,
        messageId:
          event.tool?.messageId ||
          existing?.messageId ||
          streamingMessageId ||
          "",
        questions: event.questions || existing?.questions || [],
      };

      if (event.sessionId !== activeSessionId) {
        // Cache the question for non-active sessions so it's restored on switch
        const cached = sessionDataCache.get(event.sessionId) || { todos: [], diff: [] };
        sessionDataCache.set(event.sessionId, { ...cached, pendingQuestion: questionData });
        return;
      }

      set({ pendingQuestion: questionData });

      // Also save to cache so it survives session switching
      const cachedActive = sessionDataCache.get(activeSessionId) || { todos: [], diff: [] };
      sessionDataCache.set(activeSessionId, { ...cachedActive, pendingQuestion: questionData });

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
