import { getOpenCodeClient } from "@/lib/opencode/client";
import type {
  MessageCreatedEvent,
  MessagePartCreatedEvent,
  MessagePartUpdatedEvent,
  MessageCompletedEvent,
} from "@/lib/opencode/types";
import type {
  SessionState,
} from "./session-types";
import {
  sessionLookupCache,
  getSessionById,
} from "./session-cache";
import {
  externalReloadingSessions,
  clearMessageTimeout,
} from "./session-internals";
import {
  useStreamingStore,
  appendTextBuffer,
  appendReasoningBuffer,
  scheduleTypewriter,
  hasBufferedContent,
  flushAllPending,
} from "@/stores/streaming";
import { insertMessageSorted } from "@/lib/insert-message-sorted";
import type { MessagePart, Message } from "./session-types";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

// Track retry counts for message completion deferrals (per messageId)
const completionRetryCount = new Map<string, number>();

// Debug logging — off by default; enable via: localStorage.setItem('debug-streaming', '1')
const DEBUG = () => {
  try { return localStorage.getItem('debug-streaming') === '1' } catch { return false }
};

export function createMessageHandlers(set: SessionSet, get: SessionGet) {
  return {
    handleMessageCreated: (event: MessageCreatedEvent) => {
      const { activeSessionId } = get();
      const { streamingMessageId } = useStreamingStore.getState();
      if (event.sessionId !== activeSessionId) return;

      if (externalReloadingSessions.has(event.sessionId)) {
        console.log("[Session] Suppressing handleMessageCreated during external reload");
        return;
      }

      // Handle user message: update ID from temp to real, preserve retrievedChunks
      if (event.role === "user") {
        set((state) => {
          const session = getSessionById(event.sessionId);
          if (!session) return state;

          const tempUserMsg = [...session.messages].reverse().find(
            (m) => m.role === "user" && m.id.startsWith("temp-user-")
          );

          if (tempUserMsg) {
            const newSession = {
              ...session,
              messages: session.messages.map((m) =>
                m.id === tempUserMsg.id
                  ? {
                      ...m,
                      id: event.id,
                      timestamp: new Date(event.createdAt),
                    }
                  : m,
              ),
              updatedAt: new Date(),
            };
            sessionLookupCache.set(event.sessionId, newSession);

            return {
              sessions: state.sessions.map((s) =>
                s.id === event.sessionId ? newSession : s,
              ),
            };
          }

          return state;
        });
        return;
      }

      if (event.role === "assistant") {
        clearMessageTimeout();
        const hasPendingMessage =
          streamingMessageId?.startsWith("pending-assistant-");

        if (hasPendingMessage) {
          // CRITICAL: Set streaming BEFORE updating session state (same as other branches).
          // This branch handles replacing "pending-assistant-xxx" with real message ID.
          // CRITICAL: Preserve existing streamingContent to avoid losing already-revealed text!
          const currentStreamingContent = useStreamingStore.getState().streamingContent;
          useStreamingStore.getState().setStreaming(event.id, currentStreamingContent);
          if (DEBUG()) console.log("[MessageCreated] Pending → real:", event.id);
          
          set((state) => {
            const session = getSessionById(event.sessionId);
            if (!session) return state;

            const newSession = {
              ...session,
              messages: session.messages.map((m) =>
                m.id === streamingMessageId
                  ? {
                      ...m,
                      id: event.id,
                      timestamp: new Date(event.createdAt),
                    }
                  : m,
              ),
              updatedAt: new Date(),
            };
            sessionLookupCache.set(event.sessionId, newSession);

            return {
              sessions: state.sessions.map((s) =>
                s.id === event.sessionId ? newSession : s,
              ),
            };
          });
        } else {
          const session = getSessionById(event.sessionId);
          const messageExists = session?.messages.some((m) => m.id === event.id);

          if (messageExists) {
            if (DEBUG()) console.log("[MessageCreated] Resuming streaming:", event.id);
            const existingMessage = session?.messages.find(m => m.id === event.id);

            // CRITICAL: Set streaming BEFORE updating session state.
            // This ensures streamingMessageId is set synchronously before any delta events arrive.
            useStreamingStore.getState().setStreaming(event.id, existingMessage?.content || "");
            
            // CRITICAL: Restore streaming state when message already exists.
            // This handles retry scenarios where:
            // 1. Message was created before retry
            // 2. Retry caused temporary state interruption
            // 3. OpenCode resends message.updated after retry succeeds
            // We restore streaming to ensure subsequent delta events are processed.
            if (existingMessage && !existingMessage.isStreaming) {
              if (DEBUG()) console.log("[MessageCreated] Restoring isStreaming for:", event.id);
              set((state) => {
                const session = getSessionById(event.sessionId);
                if (!session) return state;
                
                const newSession = {
                  ...session,
                  messages: session.messages.map((m) =>
                    m.id === event.id ? { ...m, isStreaming: true } : m
                  ),
                  updatedAt: new Date(),
                };
                sessionLookupCache.set(event.sessionId, newSession);
                
                return {
                  sessions: state.sessions.map((s) =>
                    s.id === event.sessionId ? newSession : s
                  ),
                };
              });
            }
          } else {
            if (DEBUG()) console.log("[MessageCreated] New assistant message:", event.id);
            const newMessage: Message = {
              id: event.id,
              sessionId: event.sessionId,
              role: "assistant",
              content: "",
              parts: [],
              timestamp: new Date(event.createdAt),
              isStreaming: true,
            };

            // CRITICAL: Set streaming BEFORE updating session state.
            // This ensures streamingMessageId is set synchronously before any delta events arrive.
            // If called inside set(), Zustand batching may delay the update, causing delta events
            // to see streamingMessageId=null and get ignored.
            useStreamingStore.getState().setStreaming(event.id);
            if (DEBUG()) console.log("[MessageCreated] Set streaming for:", event.id);

            set((state) => {
              const session = getSessionById(event.sessionId);
              if (!session) return state;

              const newSession = {
                ...session,
                messages: insertMessageSorted(session.messages, newMessage),
                updatedAt: new Date(),
              };
              sessionLookupCache.set(event.sessionId, newSession);

              return {
                sessions: state.sessions.map((s) =>
                  s.id === event.sessionId ? newSession : s,
                ),
              };
            });
          }
        }
      }
    },

    handleMessagePartCreated: (event: MessagePartCreatedEvent) => {
      const { activeSessionId } = get();
      let { streamingMessageId } = useStreamingStore.getState();
      
      if (DEBUG()) console.log("[PartCreated]", event.type, event.partId);
      
      // CRITICAL: Auto-recovery for lost streamingMessageId (same as handleMessagePartUpdated)
      if (event.messageId !== streamingMessageId && activeSessionId) {
        const session = getSessionById(activeSessionId);
        const targetMessage = session?.messages.find(m => m.id === event.messageId);
        
        if (targetMessage?.isStreaming) {
          console.warn("[PartCreated] Auto-recovering lost streamingMessageId:", {
            eventMessageId: event.messageId,
            oldStreamingId: streamingMessageId,
          });
          useStreamingStore.getState().setStreaming(event.messageId, targetMessage.content || "");
          streamingMessageId = event.messageId;
        } else {
          if (DEBUG()) console.log("[PartCreated] Ignoring part for non-streaming message:", event.messageId);
          return;
        }
      }
      
      if (!activeSessionId) return;
      if (activeSessionId && externalReloadingSessions.has(activeSessionId)) return;

      clearMessageTimeout();

      // PERF: Update sessionLookupCache directly instead of going through sessions.map().
      // PartCreated fires 5-20x per conversation (per text/tool part). The old code did:
      //   1. findIndex O(n) on messages
      //   2. findIndex O(p) on parts
      //   3. parts.map O(p) to replace one part
      //   4. sessions.map O(s) to replace one session  ← triggers all session selectors
      // Now: direct index access + cache-only write. Session store syncs on completion.
      const session = getSessionById(activeSessionId);
      if (!session) return;

      const msgIndex = session.messages.findIndex((m) => m.id === event.messageId);
      if (msgIndex === -1) return;

      const messages = session.messages.slice();
      const msg = { ...messages[msgIndex] };

      const newPart: MessagePart = {
        id: event.partId,
        type: event.type as MessagePart["type"],
        content: event.content,
        text: event.text || event.content,
        tool: event.tool,
        result: event.result,
      };

      const existingPartIndex = msg.parts.findIndex(
        (p) => p.id === event.partId,
      );
      if (existingPartIndex !== -1) {
        const parts = msg.parts.slice();
        parts[existingPartIndex] = newPart;
        msg.parts = parts;
      } else {
        msg.parts = [...msg.parts, newPart];
      }

      if (event.type === "tool_call" && event.tool) {
        const existingToolCall = msg.toolCalls?.find(
          (tc) => tc.id === event.tool!.id,
        );
        if (!existingToolCall) {
          msg.toolCalls = [
            ...(msg.toolCalls || []),
            {
              id: event.tool.id,
              name: event.tool.name,
              status: "calling",
              arguments: event.tool.input,
              startTime: new Date(),
            },
          ];
        }
      }

      messages[msgIndex] = msg;
      const newSession = { ...session, messages };

      // Write to cache only — no sessions.map() needed during streaming.
      // The session store will be synced when handleMessageCompleted runs.
      sessionLookupCache.set(activeSessionId, newSession);

      if (event.type === "text" && event.content) {
        // Trigger scroll after tool completion (text snapshot arrives after tool output)
        const currentTrigger = useStreamingStore.getState().streamingUpdateTrigger;
        useStreamingStore.setState({ streamingUpdateTrigger: currentTrigger + 1 });
      }

      // For tool_call parts, we need to update session store so ToolCallCard renders.
      // Text parts don't need this — they're displayed via streamingContent.
      if (event.type === "tool_call" || event.type === "step-start" || event.type === "step-finish") {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === activeSessionId ? newSession : s,
          ),
        }));
      }
    },

    handleMessagePartUpdated: (event: MessagePartUpdatedEvent) => {
      const { activeSessionId } = get();
      let { streamingMessageId } = useStreamingStore.getState();
      
      // CRITICAL: Auto-recovery for lost streamingMessageId
      // In rapid message succession (e.g., tool call → new message), streamingMessageId
      // may be cleared prematurely. If we receive delta events for a message that:
      // 1. Is in the current session
      // 2. Has isStreaming=true
      // 3. But streamingMessageId doesn't match
      // → Restore streaming state automatically
      if (event.messageId !== streamingMessageId && activeSessionId) {
        const session = getSessionById(activeSessionId);
        const targetMessage = session?.messages.find(m => m.id === event.messageId);
        
        if (targetMessage?.isStreaming) {
          console.warn("[PartUpdated] Auto-recovering lost streamingMessageId:", {
            eventMessageId: event.messageId,
            oldStreamingId: streamingMessageId,
          });
          useStreamingStore.getState().setStreaming(event.messageId, targetMessage.content || "");
          streamingMessageId = event.messageId; // Update local variable
        } else {
          if (DEBUG()) console.log("[PartUpdated] Ignoring delta for non-streaming message:", event.messageId);
          return;
        }
      }
      
      if (activeSessionId && externalReloadingSessions.has(activeSessionId)) return;

      clearMessageTimeout();

      if (event.type === "text_delta" && event.delta) {
        appendTextBuffer(event.delta);
        scheduleTypewriter();
      } else if (event.type === "reasoning_delta" && event.delta) {
        appendReasoningBuffer(event.partId, event.delta);
        scheduleTypewriter();
      }
    },

    handleMessageCompleted: (event: MessageCompletedEvent) => {
      const { streamingMessageId: currentStreamingId } = useStreamingStore.getState();
      const retryCount = completionRetryCount.get(event.messageId) || 0;
      
      if (DEBUG()) console.log("[MessageCompleted]", event.messageId, { retryCount });
      
      // CRITICAL: Ignore completion events for non-streaming messages
      // This prevents stale/duplicate message.completed events (from retries or out-of-order delivery)
      // from clearing the streaming state of the current active message
      if (currentStreamingId && currentStreamingId !== event.messageId) {
        console.warn("[MessageCompleted] Ignoring completion for non-streaming message:", {
          eventMessageId: event.messageId,
          currentStreamingId,
        });
        return;
      }

      // Check if buffer has content
      if (hasBufferedContent()) {
        // CRITICAL: Allow typewriter to finish naturally to maintain smooth effect until the end
        // Previously: 3 retries * 50ms = 150ms was too short for large buffers
        // With CHARS_PER_FRAME=3 at 60fps, that's only ~27 characters revealed
        // New strategy: 20 retries * 100ms = 2000ms max wait
        // This handles buffers up to ~360 characters while keeping typewriter effect
        if (retryCount < 20) {
          if (DEBUG()) console.log("[MessageCompleted] Deferring, retry:", retryCount + 1);
          completionRetryCount.set(event.messageId, retryCount + 1);
          setTimeout(() => {
            get().handleMessageCompleted(event);
          }, 100);
          return;
        }
        
        // After 2000ms total, force flush to ensure all content is displayed
        // This should rarely happen, only for extremely long messages
        if (DEBUG()) console.log("[MessageCompleted] Max deferrals, force flushing");
        const flushedContent = flushAllPending();
        // Use flushed content if we don't have finalContent from server
        if (!event.finalContent && flushedContent) {
          event = { ...event, finalContent: flushedContent };
        }
      }

      // Clear retry count for this message
      completionRetryCount.delete(event.messageId);

      // CRITICAL: Get streaming state AFTER flush to include flushed content

      set((state) => {
        const currentSession = getSessionById(event.sessionId);
        if (!currentSession) {
          useStreamingStore.getState().clearStreaming();
          return {};
        }

        const msgIndex = currentSession.messages.findIndex((m) => m.id === event.messageId);
        if (msgIndex === -1) {
          useStreamingStore.getState().clearStreaming();
          return {};
        }

        const messages = [...currentSession.messages];
        
        // CRITICAL ARCHITECTURE: Single Source of Truth - Parts
        // During streaming, we showed streamingContent (from delta buffer).
        // Now message is complete, build final content ONLY from parts (authoritative source).
        // This prevents duplication from mixing snapshot content + buffer content.
        const textPartsContent = messages[msgIndex].parts
          .filter((p) => p.type === "text" && (p.text || p.content))
          .map((p) => p.text || p.content || "")
          .join("");
        
        // Fallback: If parts are empty, try event.finalContent or API fetch
        const finalContent = textPartsContent || event.finalContent || "";
        
        if (DEBUG()) console.log("[MessageCompleted] Final content:", finalContent.length, "chars");

        // If content is still empty after all fallbacks, fetch from API asynchronously
        if (!finalContent || finalContent.trim() === '') {
          const client = getOpenCodeClient();
          client.getMessages(event.sessionId)
            .then((apiMessages) => {
              const apiMessage = apiMessages.find((m) => m.info.id === event.messageId);
              if (apiMessage) {
                const apiContent = apiMessage.parts
                  .filter((p) => p.type === 'text' && p.text)
                  .map((p) => p.text)
                  .join('');

                if (apiContent && apiContent.trim() !== '') {
                  set((state) => {
                    const session = getSessionById(event.sessionId);
                    if (!session) return {};

                    const msgIndex = session.messages.findIndex((m) => m.id === event.messageId);
                    if (msgIndex === -1) return {};

                    const messages = [...session.messages];
                    messages[msgIndex] = {
                      ...messages[msgIndex],
                      content: apiContent,
                    };

                    const newSession = { ...session, messages };
                    sessionLookupCache.set(event.sessionId, newSession);

                    return {
                      sessions: state.sessions.map((s) =>
                        s.id === event.sessionId ? newSession : s,
                      ),
                    };
                  });
                }
              }
            })
            .catch((error) => {
              console.error('[Session] Failed to fetch message content from API:', error);
            });
        }

        messages[msgIndex] = {
          ...messages[msgIndex],
          content: finalContent,
          isStreaming: false,
          tokens: event.tokens ?? messages[msgIndex].tokens,
          cost: event.cost ?? messages[msgIndex].cost,
          toolCalls: messages[msgIndex].toolCalls?.map((tc) =>
            tc.status === "calling"
              ? {
                  ...tc,
                  status: "completed" as const,
                  duration: tc.startTime
                    ? Date.now() - tc.startTime.getTime()
                    : tc.duration,
                }
              : tc,
          ),
        };

        const newSession = { ...currentSession, messages };
        sessionLookupCache.set(event.sessionId, newSession);

        // CRITICAL: Delay clearStreaming() to allow React to re-render and trigger auto-scroll
        // When flushAllPending() dumps large buffer content, React needs time to:
        // 1. Re-render the message with new content
        // 2. Update DOM (scrollHeight increases)
        // 3. Trigger scroll useEffect (depends on streamingContentLength)
        // 
        // IMPORTANT: Only clear if this message is STILL the streaming message.
        // In rapid succession scenarios, a new message may have started streaming
        // within the 100ms delay. We must not clear the new message's streamingMessageId.
        const completedMessageId = event.messageId;
        setTimeout(() => {
          const { streamingMessageId: currentStreamingId } = useStreamingStore.getState();
          if (currentStreamingId === completedMessageId) {
            useStreamingStore.getState().clearStreaming();
          }
        }, 100);
        
        return {
          sessions: state.sessions.map((s) =>
            s.id === event.sessionId ? newSession : s,
          ),
        };
      });

      // Update local stats: add token usage when message completes
      if (event.tokens || event.cost) {
        (async () => {
          try {
            const { useWorkspaceStore } = await import('@/stores/workspace');
            const { useLocalStatsStore } = await import('@/stores/local-stats');
            const workspacePath = useWorkspaceStore.getState().workspacePath;
            
            if (workspacePath) {
              const tokens = event.tokens 
                ? (event.tokens.input || 0) + (event.tokens.output || 0) + (event.tokens.reasoning || 0)
                : 0;
              const cost = event.cost || 0;
              
              if (tokens > 0 || cost > 0) {
                await useLocalStatsStore.getState().addTokenUsage(workspacePath, tokens, cost);
                if (DEBUG()) console.log(`[LocalStats] ${tokens} tokens, $${cost.toFixed(4)}`);
              }
            }
          } catch (error) {
            console.error('[LocalStats] Failed to update from message completion:', error);
          }
        })();
      }

      // Process next message in queue after completion
      setTimeout(() => {
        const { messageQueue, sendMessage: send } = get();
        if (messageQueue.length > 0) {
          const nextMessage = messageQueue[0];
          set((state) => ({
            messageQueue: state.messageQueue.slice(1),
          }));
          send(nextMessage.content);
        }
      }, 300);
    },
  };
}
