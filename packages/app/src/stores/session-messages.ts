import { getOpenCodeClient } from "@/lib/opencode/client";
import type { SendMessageFilePart, SessionErrorEvent } from "@/lib/opencode/types";
import type {
  Message,
  QueuedMessage,
  SessionState,
} from "./session-types";
import type { SearchResult } from "@/stores/knowledge";
import { convertMessage } from "./session-converters";
import {
  getSessionById,
  updateSessionCache,
} from "./session-cache";
import {
  busySessions,
  clearMessageTimeout,
  setMessageTimeout,
} from "./session-internals";
import {
  useStreamingStore,
  cleanupAllChildSessions,
} from "@/stores/streaming";
import { insertMessageSorted } from "@/lib/insert-message-sorted";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

export function createMessageActions(set: SessionSet, get: SessionGet) {
  return {
    // RAG V2: Auto-inject knowledge from pre-inference search
    autoInjectKnowledge: async (userMessage: string): Promise<{ context?: string; chunks?: SearchResult[] }> => {
      try {
        const { useKnowledgeStore } = await import('./knowledge')
        const config = useKnowledgeStore.getState().config

        if (!config || !config.autoInjectEnabled) {
          return {}
        }

        const topK = config.autoInjectTopK
        const minScore = config.autoInjectThreshold
        const maxTokens = config.autoInjectMaxTokens

        console.log('[RAG Auto-Inject] Searching with:', { topK, minScore, maxTokens })

        const searchForAutoInject = useKnowledgeStore.getState().searchForAutoInject
        const results = await searchForAutoInject(userMessage, topK, minScore)

        if (results.length === 0) {
          console.log('[RAG Auto-Inject] No results above threshold, skipping injection')
          return {}
        }

        console.log(`[RAG Auto-Inject] Found ${results.length} results above threshold`)

        const contextLines: string[] = [
          '## \u76f8\u5173\u77e5\u8bc6\u5e93\u5185\u5bb9',
          '',
          '\u4ee5\u4e0b\u662f\u4ece\u77e5\u8bc6\u5e93\u4e2d\u68c0\u7d22\u5230\u7684\u76f8\u5173\u4fe1\u606f\uff0c\u8bf7\u53c2\u8003\u8fd9\u4e9b\u5185\u5bb9\u56de\u7b54\u7528\u6237\u95ee\u9898\uff1a',
          '',
        ]

        let estimatedTokens = contextLines.join('\n').length / 4
        const includedChunks: SearchResult[] = []

        for (let i = 0; i < results.length; i++) {
          const result = results[i]
          const chunk = [
            `### \u7247\u6bb5 ${i + 1} (\u6765\u6e90: ${result.source}, \u76f8\u4f3c\u5ea6: ${result.score.toFixed(2)})`,
            result.heading ? `**\u7ae0\u8282**: ${result.heading}` : '',
            '',
            result.content,
            '',
          ].filter(Boolean).join('\n')

          const chunkTokens = chunk.length / 4

          if (estimatedTokens + chunkTokens > maxTokens) {
            console.log(`[RAG Auto-Inject] Reached token limit (${maxTokens}), stopping at ${i} chunks`)
            break
          }

          contextLines.push(chunk)
          estimatedTokens += chunkTokens
          includedChunks.push(result)
        }

        const injectedContext = contextLines.join('\n')
        console.log(`[RAG Auto-Inject] Injected ${estimatedTokens.toFixed(0)} tokens from ${includedChunks.length} chunks`)

        return {
          context: injectedContext,
          chunks: includedChunks
        }
      } catch (error) {
        console.error('[RAG Auto-Inject] Failed:', error)
        return {}
      }
    },

    // Send a message to the active session (auto-creates session if needed)
    sendMessage: async (content: string, agent?: string, imageParts?: SendMessageFilePart[]) => {
      if (!content.trim() && (!imageParts || imageParts.length === 0)) return;

      let { activeSessionId } = get();
      const { streamingMessageId } = useStreamingStore.getState();

      // Auto-create a session if there isn't one
      if (!activeSessionId) {
        console.log("[Session] No active session, creating new one...");
        const newSession = await get().createSession();
        if (!newSession) {
          console.error("[Session] Failed to create session");
          return;
        }
        activeSessionId = newSession.id;
        console.log("[Session] Created new session:", activeSessionId);
      }

      const { sessionStatus, messageQueue: currentQueue } = get();
      console.log("[SendMessage] entry:", {
        streamingMessageId,
        sessionStatusType: sessionStatus?.type,
        queueLength: currentQueue.length,
        content: content.trim().slice(0, 30),
      });

      // If currently streaming, add to queue instead of sending
      if (streamingMessageId) {
        console.log("[SendMessage] QUEUED (streamingMessageId is set):", streamingMessageId);
        const queuedMessage: QueuedMessage = {
          id: `queue-${Date.now()}`,
          content: content.trim(),
          timestamp: new Date(),
        };
        set((state) => ({
          messageQueue: [...state.messageQueue, queuedMessage],
        }));
        return;
      }

      const now = Date.now();

      // Add optimistic user message
      const userMessage: Message = {
        id: `temp-user-${now}`,
        sessionId: activeSessionId,
        role: "user",
        content: content.trim(),
        parts: [{ id: `part-${now}`, type: "text", content: content.trim() }],
        timestamp: new Date(),
      };

      // If the session is already in retry, don't create a pending assistant
      if (sessionStatus?.type === 'retry') {
        console.log("[SendMessage] Session in RETRY \u2014 sending without streaming UI");
        const retryError: SessionErrorEvent = {
          sessionId: activeSessionId,
          error: {
            name: "RetryError",
            data: {
              message: sessionStatus.message,
              isRetryable: true,
            },
          },
        };
        set((state) => {
          const newSessions = state.sessions.map((s) =>
            s.id === activeSessionId
              ? {
                  ...s,
                  messages: insertMessageSorted(s.messages, userMessage),
                  updatedAt: new Date(),
                }
              : s,
          );
          updateSessionCache(newSessions);
          return { sessions: newSessions, sessionError: retryError };
        });
        try {
          const client = getOpenCodeClient();
          const { selectedModel } = get();
          const modelParam = selectedModel
            ? { providerID: selectedModel.providerID, modelID: selectedModel.modelID }
            : undefined;
          await client.sendMessageAsync(activeSessionId, content.trim(), modelParam, agent);
        } catch (e) {
          console.warn("[SendMessage] Failed to send during retry (server-side queue):", e);
        }
        return;
      }

      // Create a pending assistant message placeholder for immediate loading feedback
      const pendingAssistantId = `pending-assistant-${now}`;
      const pendingAssistantMessage: Message = {
        id: pendingAssistantId,
        sessionId: activeSessionId,
        role: "assistant",
        content: "",
        parts: [],
        timestamp: new Date(),
        isStreaming: true,
      };

      set((state) => {
        const newSessions = state.sessions.map((s) =>
          s.id === activeSessionId
            ? {
                ...s,
                messages: insertMessageSorted(insertMessageSorted(s.messages, userMessage), pendingAssistantMessage),
                title:
                  s.messages.length === 0
                    ? content.slice(0, 50) + (content.length > 50 ? "..." : "")
                    : s.title,
                updatedAt: new Date(),
              }
            : s,
        );
        updateSessionCache(newSessions);

        useStreamingStore.getState().setStreaming(pendingAssistantId);
        return {
          sessions: newSessions,
          sessionError: null,
        };
      });

      // Set timeout immediately after streaming starts — before any async work (RAG, API call).
      // This ensures that if autoInjectKnowledge or the API call hangs, the timeout still fires.
      setMessageTimeout(pendingAssistantId, activeSessionId);

      try {
        const client = getOpenCodeClient();
        const { selectedModel } = get();
        const modelParam = selectedModel
          ? {
              providerID: selectedModel.providerID,
              modelID: selectedModel.modelID,
            }
          : undefined;
        let systemPrompt: string | undefined;
        try {
          const stored = localStorage.getItem('teamclaw-system-prompt');
          if (stored && stored.trim()) {
            systemPrompt = stored.trim();
          }
        } catch (error) {
          console.error('[Session] Failed to load system prompt:', error);
        }

        // RAG V2: Auto-inject knowledge before sending message
        // Wrap with a 3-second timeout to prevent hanging if knowledge search is unresponsive
        const RAG_TIMEOUT_MS = 3000;
        const ragResult = await Promise.race([
          get().autoInjectKnowledge(content.trim()),
          new Promise<{ context?: string; chunks?: SearchResult[] }>((resolve) =>
            setTimeout(() => {
              console.warn('[RAG Auto-Inject] Timed out after', RAG_TIMEOUT_MS, 'ms, skipping');
              resolve({});
            }, RAG_TIMEOUT_MS)
          ),
        ]);
        if (ragResult.context) {
          systemPrompt = systemPrompt
            ? `${ragResult.context}\n\n---\n\n${systemPrompt}`
            : ragResult.context;
        }

        if (ragResult.chunks && ragResult.chunks.length > 0) {
          set((state) => {
            const newSessions = state.sessions.map((s) =>
              s.id === activeSessionId
                ? {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === userMessage.id
                        ? { ...m, retrievedChunks: ragResult.chunks }
                        : m
                    ),
                  }
                : s,
            );
            updateSessionCache(newSessions);
            return { sessions: newSessions };
          });
        }

        // Fire-and-forget via async endpoint
        if (imageParts && imageParts.length > 0) {
          const parts = [
            { type: 'text' as const, text: content.trim() },
            ...imageParts,
          ];
          await client.sendMessageWithPartsAsync(
            activeSessionId,
            parts,
            modelParam,
            agent,
            systemPrompt,
          );
        } else {
          await client.sendMessageAsync(
            activeSessionId,
            content.trim(),
            modelParam,
            agent,
            systemPrompt,
          );
        }
        // Reset timeout after successful send — gives a fresh 5 minutes from actual send time
        setMessageTimeout(pendingAssistantId, activeSessionId);
      } catch (error) {
        clearMessageTimeout();
        set((state) => {
          const newSessions = state.sessions.map((s) =>
            s.id === activeSessionId
              ? {
                  ...s,
                  messages: s.messages.filter((m) => m.id !== pendingAssistantId),
                }
              : s,
          );
          updateSessionCache(newSessions);

          useStreamingStore.getState().clearStreaming();
          return {
            error:
              error instanceof Error ? error.message : "Failed to send message",
            sessions: newSessions,
          };
        });
      }
    },

    // Abort the current session's operation
    abortSession: async () => {
      const { activeSessionId } = get();
      if (!activeSessionId) return;
      const { streamingMessageId, childSessionStreaming } = useStreamingStore.getState();
      const childSessionIds = Object.entries(childSessionStreaming || {})
        .filter(([, state]) => state.isStreaming)
        .map(([sessionId]) => sessionId);

      // Fallback: even if streamingMessageId is null (e.g. cleared by a race condition),
      // still force-clear all streaming/UI state so the user isn't stuck with a red button.
      if (!streamingMessageId && childSessionIds.length === 0) {
        console.warn("[Session] abortSession: no streamingMessageId, force-clearing UI state");
        clearMessageTimeout();
        useStreamingStore.getState().clearStreaming();
        set((state) => ({
          pendingQuestion: null,
          pendingPermission: null,
          pendingPermissionChildSessionId: null,
          sessionError: null,
          sessions: state.sessions.map((s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.isStreaming ? { ...m, isStreaming: false } : m,
            ),
          })),
        }));
        return;
      }

      try {
        clearMessageTimeout();
        const client = getOpenCodeClient();
        const sessionIdsToAbort = Array.from(new Set([activeSessionId, ...childSessionIds]));

        // Abort with a 5-second timeout per request — don't let a hung server block the UI
        const ABORT_TIMEOUT_MS = 5000;
        const abortResults = await Promise.allSettled(
          sessionIdsToAbort.map((sessionId) =>
            Promise.race([
              client.abortSession(sessionId),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Abort request timed out')), ABORT_TIMEOUT_MS)
              ),
            ])
          ),
        );
        const failedAborts = abortResults.filter((r) => r.status === "rejected");
        if (failedAborts.length > 0) {
          console.warn("[Session] Some abort requests failed:", failedAborts);
        }

        useStreamingStore.getState().clearStreaming();
        cleanupAllChildSessions();
        set((state) => ({
          pendingQuestion: null,
          pendingPermission: null,
          pendingPermissionChildSessionId: null,
          sessions: state.sessions.map((s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.id === streamingMessageId ? { ...m, isStreaming: false } : m,
            ),
          })),
        }));

        // Process next message in queue after abort
        setTimeout(() => {
          const { messageQueue, sendMessage: send } = get();
          if (messageQueue.length > 0) {
            const nextMessage = messageQueue[0];
            set((state) => ({
              messageQueue: state.messageQueue.slice(1),
            }));
            send(nextMessage.content);
          }
        }, 500);
      } catch (error) {
        useStreamingStore.getState().clearStreaming();
        cleanupAllChildSessions();
        set({
          error:
            error instanceof Error ? error.message : "Failed to abort session",
        });
      }
    },

    // Remove a message from the queue
    removeFromQueue: (id: string) => {
      set((state) => ({
        messageQueue: state.messageQueue.filter((m) => m.id !== id),
      }));
    },

    // Reload messages for the active session from the API
    reloadActiveSessionMessages: async () => {
      const { activeSessionId } = get();
      if (!activeSessionId) return;

      console.log("[Session] Reloading messages for active session:", activeSessionId);

      try {
        const client = getOpenCodeClient();
        const messages = await client.getMessages(activeSessionId);
        const convertedMessages = messages.map(convertMessage);

        set((state) => {
          const currentSession = getSessionById(activeSessionId);
          const oldMessagesMap = new Map(
            currentSession?.messages.map((m) => [m.id, m]) || []
          );

          const oldUserMessages = currentSession?.messages.filter(m => m.role === 'user') || [];
          const newUserMessages = convertedMessages.filter(m => m.role === 'user');

          const mergedMessages = convertedMessages.map((newMsg) => {
            let oldMsg = oldMessagesMap.get(newMsg.id);

            if (!oldMsg && newMsg.role === 'user') {
              const newUserIndex = newUserMessages.findIndex(m => m.id === newMsg.id);
              if (newUserIndex !== -1 && newUserIndex < oldUserMessages.length) {
                oldMsg = oldUserMessages[newUserIndex];
              }
            }

            if (oldMsg?.retrievedChunks) {
              return { ...newMsg, retrievedChunks: oldMsg.retrievedChunks };
            }
            return newMsg;
          });
          const sortedMerged = [...mergedMessages].sort((a, b) => {
            const ta = a.timestamp?.getTime?.() ?? 0;
            const tb = b.timestamp?.getTime?.() ?? 0;
            if (ta !== tb) return ta - tb;
            return (a.id || "").localeCompare(b.id || "");
          });

          const newSessions = state.sessions.map((s) =>
            s.id === activeSessionId
              ? { ...s, messages: sortedMerged, updatedAt: new Date() }
              : s,
          );

          const isBusy = busySessions.has(activeSessionId);
          if (isBusy && convertedMessages.length > 0) {
            const lastMsg = convertedMessages[convertedMessages.length - 1];
            if (lastMsg.role === "assistant") {
              console.log("[Session] Session is busy after reload, resuming streaming for:", lastMsg.id);
              const sessionsWithStreaming = newSessions.map((s) =>
                s.id === activeSessionId
                  ? {
                      ...s,
                      messages: s.messages.map((m) =>
                        m.id === lastMsg.id ? { ...m, isStreaming: true } : m,
                      ),
                    }
                  : s,
              );
              updateSessionCache(sessionsWithStreaming);
              useStreamingStore.getState().setStreaming(lastMsg.id, lastMsg.content || "");

              return {
                sessions: sessionsWithStreaming,
              };
            }
          }

          return {
            sessions: newSessions,
          };
        });

        console.log("[Session] Reloaded", messages.length, "messages for active session");
      } catch (error) {
        console.error("[Session] Failed to reload messages:", error);
      }
    },
  };
}
