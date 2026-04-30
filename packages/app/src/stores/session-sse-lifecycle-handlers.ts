import { getCurrentWindow } from "@tauri-apps/api/window";
import { notificationService } from "@/lib/notification-service";
import { buildConfig } from "@/lib/build-config";
import { getOpenCodeClient } from "@/lib/opencode/sdk-client";
import type {
  SessionErrorEvent,
} from "@/lib/opencode/sdk-types";
import type {
  SessionCreatedEvent,
  SessionUpdatedEvent,
  ExternalMessageEvent,
  SessionBusyEvent,
  SessionIdleEvent,
  SessionStatusEvent,
  OpenCodeSSEEvent,
} from "@/lib/opencode/sdk-sse";
import {
  registerChildSession,
  isChildSession,
} from "@/lib/opencode/sdk-sse";
import { useWorkspaceStore } from "@/stores/workspace";
import type {
  SessionState,
} from "./session-types";
import {
  sessionLookupCache,
  getSessionById,
  updateSessionCache,
} from "./session-cache";
import {
  hasBufferedContent,
} from "./streaming";
import {
  selfCreatedSessionIds,
  busySessions,
  debouncedRefreshSessions,
  debouncedReloadMessages,
  clearMessageTimeout,
} from "./session-internals";
import {
  useStreamingStore,
  childStreamingBuffers,
  childPartTypes,
  scheduleChildStreamingFlush,
  cleanupChildSession,
} from "@/stores/streaming";
import { workspacePathsMatch } from "./session-utils";
import {
  removeSessionActivityEntries,
  resolvePendingPermissionActivityOwner,
  resolvePendingQuestionActivityOwner,
  updateSessionStatusEntry,
} from "@/lib/session-list-activity";

// --- Retry timeout ---
// Safety net: if OpenCode keeps retrying beyond this duration,
// clear streaming to prevent stuck UI (send button stays loading forever)
let retryTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RETRY_DURATION_MS = 120_000; // 2 minutes

const clearRetryTimeout = () => {
  if (retryTimeoutTimer) {
    clearTimeout(retryTimeoutTimer);
    retryTimeoutTimer = null;
  }
};

function isContextOverflowMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("input exceeds context window") ||
    (lower.includes("context window") &&
      (lower.includes("exceed") || lower.includes("overflow") || lower.includes("full")))
  );
}

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

// Shared helper: add a child session to the store and set up streaming if needed
function addChildSession(
  set: SessionSet,
  _get: SessionGet,
  sessionId: string,
  parentID: string,
  activeSessionId: string | null,
  title?: string,
) {
  set((state) => {
    const exists = state.sessions.some((s) => s.id === sessionId);
    if (exists) {
      // Backfill parentID if missing
      const session = state.sessions.find((s) => s.id === sessionId);
      if (session && !session.parentID) {
        return {
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, parentID, ...(title ? { title } : {}) } : s,
          ),
        };
      }
      return {};
    }
    return {
      sessions: [...state.sessions, {
        id: sessionId,
        title: title || "Sub-agent",
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        parentID,
      }],
    };
  });

  // Set up streaming tracking for children of the active session
  if (parentID === activeSessionId && !isChildSession(sessionId)) {
    registerChildSession(sessionId);
    childStreamingBuffers.set(sessionId, { text: "", reasoning: "" });
    useStreamingStore.getState().setChildStreaming(sessionId, {
      sessionId,
      text: "",
      reasoning: "",
      isStreaming: true,
    });
  }
}

export function createLifecycleHandlers(set: SessionSet, get: SessionGet) {
  return {
    // Handle session.created SSE event (global)
    handleSessionCreated: (event: SessionCreatedEvent) => {
      const { activeSessionId } = get();
      const workspacePath = useWorkspaceStore.getState().workspacePath;

      if (selfCreatedSessionIds.has(event.sessionId)) {
        console.log("[Session] Ignoring SSE for self-created session:", event.sessionId);
        selfCreatedSessionIds.delete(event.sessionId);
        return;
      }

      if (event.directory && workspacePath) {
        if (!workspacePathsMatch(event.directory, workspacePath)) {
          return;
        }
      }

      // If parentID is known from SSE, handle immediately as child session
      if (event.parentID) {
        addChildSession(set, get, event.sessionId, event.parentID, activeSessionId);
        return;
      }

      // parentID may be absent from SSE (OpenCode v1.2.x timing issue).
      // Fetch session info from API to check before adding to the session list.
      getOpenCodeClient().getSession(event.sessionId).then((sessionInfo) => {
        if (sessionInfo?.parentID) {
          addChildSession(set, get, event.sessionId, sessionInfo.parentID, get().activeSessionId, sessionInfo.title);
        } else {
          // Confirmed root session — add to list
          import("@/stores/cron").then(({ useCronStore }) => {
            useCronStore.getState().loadCronSessionIds();
          });

          set((state) => ({
            highlightedSessionIds: [...state.highlightedSessionIds, event.sessionId],
          }));
          setTimeout(() => {
            import("./session-store").then(({ useSessionStore }) => {
              useSessionStore.getState().clearHighlightedSession(event.sessionId);
            });
          }, 5000);

          debouncedRefreshSessions();
        }
      }).catch(() => {
        // API unavailable — fall back to treating as root session
        debouncedRefreshSessions();
      });
    },

    // Handle session.updated SSE event (global)
    handleSessionUpdated: (event: SessionUpdatedEvent) => {
      if (selfCreatedSessionIds.has(event.sessionId)) {
        selfCreatedSessionIds.delete(event.sessionId);
        return;
      }

      // Check if already known as a child session (registered or in store with parentID)
      const isChild = isChildSession(event.sessionId) ||
        get().sessions.some((s) => s.id === event.sessionId && s.parentID);

      // If parentID is in the event, handle as child
      if (event.parentID) {
        const existingSession = get().sessions.find(s => s.id === event.sessionId);
        if (!existingSession) {
          addChildSession(set, get, event.sessionId, event.parentID, get().activeSessionId, event.title);
        } else if (!existingSession.parentID) {
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === event.sessionId ? { ...s, parentID: event.parentID, ...(event.title ? { title: event.title } : {}) } : s,
            ),
          }));
        }
        if (event.title && isChild) {
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === event.sessionId ? { ...s, title: event.title!, updatedAt: new Date() } : s,
            ),
          }));
        }
        return;
      }

      if (isChild) {
        if (event.title) {
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === event.sessionId ? { ...s, title: event.title!, updatedAt: new Date() } : s,
            ),
          }));
        }
        return;
      }

      // Session not known as child — for existing sessions, just refresh
      const existingSession = get().sessions.find(s => s.id === event.sessionId);
      if (existingSession) {
        if (event.title) {
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === event.sessionId ? { ...s, title: event.title!, updatedAt: new Date() } : s,
            ),
          }));
        }
        debouncedRefreshSessions();
        return;
      }

      // Unknown session — check API to determine if it's a child before adding
      const workspacePath = useWorkspaceStore.getState().workspacePath;
      if (event.directory && workspacePath) {
        if (!workspacePathsMatch(event.directory, workspacePath)) {
          return;
        }
      }

      getOpenCodeClient().getSession(event.sessionId).then((sessionInfo) => {
        if (sessionInfo?.parentID) {
          addChildSession(set, get, event.sessionId, sessionInfo.parentID, get().activeSessionId, sessionInfo.title);
        } else {
          debouncedRefreshSessions();
        }
      }).catch(() => {
        debouncedRefreshSessions();
      });
    },

    // Clear a highlighted session ID
    clearHighlightedSession: (sessionId: string) => {
      set((state) => ({
        highlightedSessionIds: state.highlightedSessionIds.filter(id => id !== sessionId),
      }));
    },

    // Handle external message detected via SSE
    handleExternalMessage: (event: ExternalMessageEvent) => {
      const { activeSessionId } = get();
      const { streamingMessageId } = useStreamingStore.getState();

      console.log("[Session] External message detected:", event.messageId, "role:", event.role, "session:", event.sessionId);

      if (event.sessionId !== activeSessionId) {
        console.log("[Session] External message is for a different session, ignoring");
        return;
      }

      if (streamingMessageId) {
        console.log("[Session] Currently streaming, ignoring self-sent user message");
        return;
      }

      const session = getSessionById(event.sessionId);
      const alreadyHave = session?.messages.some(
        (m) => m.id === event.messageId || m.id === `temp-user-${event.messageId}`,
      );
      if (alreadyHave) {
        console.log("[Session] Message already in local state, skipping reload");
        return;
      }

      console.log("[Session] Triggering debounced message reload for active session");
      debouncedReloadMessages(event.sessionId);
    },

    // Track session status (busy/retry/idle)
    handleSessionStatus: (event: SessionStatusEvent) => {
      const { activeSessionId, messageQueue } = get();
      const { streamingMessageId, childSessionStreaming } = useStreamingStore.getState();
      console.log("[SessionStatus]", event.status.type, {
        sessionId: event.sessionId,
        activeSessionId,
        isActiveSession: event.sessionId === activeSessionId,
        streamingMessageId,
        queueLength: messageQueue.length,
        ...(event.status.type === 'retry' ? { attempt: event.status.attempt, message: event.status.message } : {}),
      });

      set((state) => ({
        sessionStatuses: updateSessionStatusEntry(state.sessionStatuses || {}, event.sessionId, event.status),
      }));

      const isKnownChildSession =
        !!childSessionStreaming[event.sessionId] ||
        get().sessions.some((session) => session.id === event.sessionId && !!session.parentID);

      if (isKnownChildSession) {
        if (event.status.type === 'idle') {
          const state = get();
          const hasPendingPermission = state.pendingPermissions.some(
            (entry) => entry.childSessionId === event.sessionId,
          );
          const hasPendingQuestion = state.pendingQuestions.some(
            (entry) => entry.sessionId === event.sessionId,
          );

          if (hasPendingPermission || hasPendingQuestion) {
            console.log("[Session] Child session idle but waiting for user interaction, preserving:", {
              sessionId: event.sessionId,
              hasPendingPermission,
              hasPendingQuestion,
            });
            return;
          }

          console.log("[Session] Child session idle, finalizing:", event.sessionId);
          cleanupChildSession(event.sessionId);
          set((state) => ({
            pendingPermissions: state.pendingPermissions.filter(
              (e) => e.childSessionId !== event.sessionId,
            ),
            pendingQuestions: state.pendingQuestions.filter(
              (q) => q.sessionId !== event.sessionId,
            ),
            pendingQuestionIdsBySession: removeSessionActivityEntries(
              state.pendingQuestionIdsBySession || {},
              event.sessionId,
            ),
          }));
          get().loadChildSessionMessages(event.sessionId);
        }
        return;
      }

      if (event.sessionId !== activeSessionId) return;

      const status = event.status;

      if (status.type === 'retry') {
        console.warn("[SessionStatus] RETRY detected:", {
          streamingMessageId,
          attempt: status.attempt,
          message: status.message,
          nextRetryAt: status.next,
        });

        // Check if this error is non-retryable (quota, plan limits, auth, etc.)
        // These will never succeed no matter how many times we retry.
        const retryMsg = (status.message || "").toLowerCase();
        if (isContextOverflowMessage(retryMsg)) {
          set((state) => ({
            sessionStatus: status,
            sessionError:
              state.sessionError?.error?.data?.message &&
              isContextOverflowMessage(String(state.sessionError.error.data.message))
                ? null
                : state.sessionError,
          }));
          return;
        }

        const isNonRetryable =
          retryMsg.includes("quota") ||
          retryMsg.includes("not support model") ||
          retryMsg.includes("exceeded") ||
          retryMsg.includes("unauthorized") ||
          retryMsg.includes("forbidden") ||
          retryMsg.includes("invalid api key") ||
          retryMsg.includes("token plan");

        if (isNonRetryable) {
          console.warn("[SessionStatus] Non-retryable error detected, stopping immediately:", status.message);
          clearRetryTimeout();
          clearMessageTimeout();
          useStreamingStore.getState().clearStreaming();
          set((state) => {
            const sessionId = state.activeSessionId;
            const newSessions = sessionId
              ? state.sessions.map((s) =>
                  s.id === sessionId
                    ? {
                        ...s,
                        messages: s.messages
                          .map((m) => m.isStreaming ? { ...m, isStreaming: false } : m)
                          .filter((m) => !(m.id.startsWith('pending-assistant-') && !m.content)),
                      }
                    : s,
                )
              : state.sessions;
            if (sessionId) updateSessionCache(newSessions);
            return {
              sessions: newSessions,
              sessionStatus: { type: 'idle' as const },
              sessionStatuses: updateSessionStatusEntry(state.sessionStatuses || {}, event.sessionId, { type: 'idle' }),
              sessionError: {
                sessionId: event.sessionId,
                error: {
                  name: "RetryError",
                  data: { message: status.message, isRetryable: false },
                },
              },
            };
          });

          // Abort the backend session to stop further retries
          try {
            const client = getOpenCodeClient();
            client.abortSession(event.sessionId).catch(() => {
              // Ignore abort errors — best-effort
            });
          } catch {
            // Ignore if client not available
          }
          return;
        }

        // CRITICAL: Do NOT clear streaming during retry!
        // OpenCode will automatically retry after a delay. If we clear streaming,
        // subsequent message.part.delta events will be ignored, causing content loss.
        //
        // Instead:
        // 1. Keep streamingMessageId active → continue processing delta events
        // 2. Keep message.isStreaming = true → keep Abort button visible
        // 3. Show retry error to inform user, but DON'T interrupt the stream
        // 4. When retry succeeds, OpenCode transitions to 'busy' → clear the error

        const retryError: SessionErrorEvent = {
          sessionId: event.sessionId,
          error: {
            name: "RetryError",
            data: {
              message: status.message,
              isRetryable: true,
            },
          },
        };

        set({
          sessionStatus: status,
          sessionError: retryError,
        });

        // Note: clearMessageTimeout() is intentionally NOT called here
        // The timeout should only be cleared when the message truly completes

        // Start retry timeout on first retry event — if retries don't resolve
        // within MAX_RETRY_DURATION_MS, clear streaming to prevent stuck UI
        if (!retryTimeoutTimer) {
          retryTimeoutTimer = setTimeout(() => {
            retryTimeoutTimer = null;
            const { streamingMessageId: sid } = useStreamingStore.getState();
            const currentState = get();
            if (
              currentState.activeSessionId === event.sessionId &&
              sid &&
              currentState.sessionStatus?.type === 'retry'
            ) {
              console.warn("[SessionStatus] Retry timeout reached, clearing streaming");
              clearMessageTimeout();
              useStreamingStore.getState().clearStreaming();
              set((state) => {
                const sessionId = state.activeSessionId;
                const newSessions = sessionId
                  ? state.sessions.map((s) =>
                      s.id === sessionId
                        ? {
                            ...s,
                            messages: s.messages
                              .map((m) => m.isStreaming ? { ...m, isStreaming: false } : m)
                              .filter((m) => !(m.id.startsWith('pending-assistant-') && !m.content)),
                          }
                        : s,
                    )
                  : state.sessions;
                if (sessionId) updateSessionCache(newSessions);
                return {
                  sessions: newSessions,
                  sessionStatus: { type: 'idle' as const },
                  sessionStatuses: updateSessionStatusEntry(state.sessionStatuses || {}, event.sessionId, { type: 'idle' }),
                };
              });
            }
          }, MAX_RETRY_DURATION_MS);
        }
      } else if (status.type === 'idle') {
        clearRetryTimeout();
        const wasRetrying = get().sessionStatus?.type === 'retry';

        if (wasRetrying && streamingMessageId) {
          // Retries exhausted → clear streaming to unstick UI
          console.log("[SessionStatus] Retry → idle: clearing streaming state");
          clearMessageTimeout();
          useStreamingStore.getState().clearStreaming();
          set((state) => {
            const newSessions = activeSessionId
              ? state.sessions.map((s) =>
                  s.id === activeSessionId
                    ? {
                        ...s,
                        messages: s.messages
                          .map((m) => m.isStreaming ? { ...m, isStreaming: false } : m)
                          .filter((m) => !(m.id.startsWith('pending-assistant-') && !m.content)),
                      }
                    : s,
                )
              : state.sessions;
            if (activeSessionId) updateSessionCache(newSessions);
            return {
              sessionStatus: status,
              sessionStatuses: updateSessionStatusEntry(state.sessionStatuses || {}, event.sessionId, status),
              sessionError: null,
              sessions: newSessions,
            };
          });
        } else {
          set((state) => ({
            sessionStatus: status,
            sessionStatuses: updateSessionStatusEntry(state.sessionStatuses || {}, event.sessionId, status),
            sessionError: state.sessionError?.error?.name === 'RetryError' ? null : state.sessionError,
          }));
        }
      } else {
        clearRetryTimeout();
        set((state) => ({
          sessionStatus: status,
          sessionStatuses: updateSessionStatusEntry(state.sessionStatuses || {}, event.sessionId, status),
          ...(state.sessionStatus?.type === 'retry' ? { sessionError: null } : {}),
        }));
      }
    },

    handleSessionBusy: (event: SessionBusyEvent) => {
      busySessions.add(event.sessionId);
    },

    handleSessionIdle: (event: SessionIdleEvent) => {
      clearRetryTimeout();
      busySessions.delete(event.sessionId);
      set((state) => ({
        sessionStatuses: updateSessionStatusEntry(state.sessionStatuses || {}, event.sessionId, { type: "idle" }),
      }));

      const { 
        activeSessionId, 
        sessions: currentSessions, 
        setActiveSession: navigateToSession,
        pendingQuestions,
        pendingPermissions,
      } = get();
      const { streamingMessageId } = useStreamingStore.getState();

      if (event.sessionId === activeSessionId && streamingMessageId) {
        // CRITICAL: Do NOT clear streaming if session is waiting for user interaction
        // When AI asks a question or requests permission, OpenCode sends session.idle
        // but the session is still active (waiting for user response)
        const hasPendingQuestionForActiveSession = pendingQuestions.some(
          (question) =>
            resolvePendingQuestionActivityOwner(question, currentSessions, activeSessionId) === activeSessionId,
        );
        const hasPendingPermissionForActiveSession = pendingPermissions.some(
          (permission) =>
            resolvePendingPermissionActivityOwner(permission, currentSessions, activeSessionId) === activeSessionId,
        );
        if (hasPendingQuestionForActiveSession || hasPendingPermissionForActiveSession) {
          console.log("[SessionIdle] Session waiting for user interaction, preserving streaming state:", {
            streamingMessageId,
            pendingQuestionsCount: pendingQuestions.filter(
              (question) =>
                resolvePendingQuestionActivityOwner(question, currentSessions, activeSessionId) === activeSessionId,
            ).length,
            pendingPermissionsCount: pendingPermissions.filter(
              (permission) =>
                resolvePendingPermissionActivityOwner(permission, currentSessions, activeSessionId) === activeSessionId,
            ).length,
          });
          // Keep streaming state active so:
          // 1. Typewriter continues if there's buffered content
          // 2. Abort button stays visible (not replaced by Send button)
          // 3. Message remains visually "active"
          return;
        }

        // CRITICAL: Do NOT clear streaming if typewriter buffer has content
        // This prevents race condition where:
        // 1. handleMessageCompleted defers to allow typewriter to finish (20 retries * 100ms)
        // 2. OpenCode sends session.idle before buffer is empty
        // 3. handleSessionIdle clears streaming → typewriter stops → remaining content lost
        // 4. handleMessageCompleted retry sees empty buffer → uses parts snapshot → FLASH!
        //
        // Instead, let handleMessageCompleted manage streaming lifecycle during completion.
        // Only clear here if buffer is truly empty (typewriter finished naturally).
        if (hasBufferedContent()) {
          console.log("[SessionIdle] Buffer has content, preserving streaming for typewriter to complete:", {
            streamingMessageId,
          });
          return;
        }

        console.log("[Session] Session idle, clearing streaming state for:", streamingMessageId);

        useStreamingStore.getState().clearStreaming();
        set((state) => {
          const session = getSessionById(activeSessionId);
          if (!session) {
            return {};
          }

          const newSession = {
            ...session,
            messages: session.messages
              .map((m) => m.id === streamingMessageId ? { ...m, isStreaming: false } : m)
              .filter((m) => !(m.id.startsWith('pending-assistant-') && !m.content)),
          };
          sessionLookupCache.set(activeSessionId, newSession);

          return {
            sessions: state.sessions.map((s) =>
              s.id === activeSessionId ? newSession : s,
            ),
          };
        });
      }

      // Send notification when session becomes idle
      console.log("[SessionIdle] Notification check:", {
        sessionId: event.sessionId,
        activeSessionId,
        isChildSession: isChildSession(event.sessionId),
      });

      if (isChildSession(event.sessionId)) {
        console.log("[SessionIdle] Skipping notification for child session:", event.sessionId);
      } else {
        const session = currentSessions.find((s) => s.id === event.sessionId);

        if (!session) {
          console.log("[SessionIdle] Skipping notification for unknown session:", event.sessionId);
        } else {
          const sessionTitle = session.title || "Session";
          const lastAiMessage = session.messages.filter((m) => m.role === "assistant").pop();
          const contentPreview = lastAiMessage?.content?.slice(0, 150) || "Task completed";

          console.log("[SessionIdle] Sending notification for main session:", sessionTitle);
          notificationService.send(
            "task_completed",
            `${buildConfig.app.name} - ${sessionTitle}`,
            contentPreview,
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
      }

      // Process next message in queue when session is idle
      if (event.sessionId === activeSessionId) {
        const { messageQueue, sendMessage: send } = get();
        console.log("[SessionIdle] queue check:", { queueLength: messageQueue.length });
        if (messageQueue.length > 0) {
          const nextMessage = messageQueue[0];
          console.log("[SessionIdle] processing next queued message:", nextMessage.content.slice(0, 30));
          set((state) => ({
            messageQueue: state.messageQueue.slice(1),
          }));
          send(nextMessage.content);
        }
      }

      // Trigger telemetry scoring on session idle
      import('@/stores/telemetry').then(({ useTelemetryStore }) => {
        useTelemetryStore.getState().handleSessionIdle(event.sessionId);
      }).catch(() => {
        // telemetry module not available, skip
      });
    },

    // Handle session.error SSE event
    handleSessionError: (event: SessionErrorEvent) => {
      const { activeSessionId, sessions: currentSessions, setActiveSession: navigateToSession } = get();
      const { streamingMessageId } = useStreamingStore.getState();
      console.log("[Session] handleSessionError called, sessionId:", event.sessionId, "activeSessionId:", activeSessionId, "error:", event.error?.data?.message);

      const errorMsg = event.error?.data?.message || "";
      const errorName = event.error?.name || "";
      if (isContextOverflowMessage(errorMsg)) {
        console.log("[Session] Context overflow transition suppressed; OpenCode will compact and continue");
        const errorSessionId = event.sessionId || activeSessionId;
        set((state) => ({
          sessionError: null,
          sessionStatuses: errorSessionId
            ? removeSessionActivityEntries(state.sessionStatuses || {}, errorSessionId)
            : state.sessionStatuses,
        }));
        return;
      }
      if (
        errorMsg.toLowerCase().includes("aborted") ||
        errorName === "AbortError"
      ) {
        console.log("[Session] Abort error suppressed (user-initiated cancel)");
        clearRetryTimeout();
        clearMessageTimeout();
        set((state) => {
          const newSessions = activeSessionId
            ? state.sessions.map((s) =>
                s.id === activeSessionId
                  ? {
                      ...s,
                      messages: s.messages
                        .map((m) => m.isStreaming ? { ...m, isStreaming: false } : m)
                        .filter((m) => !(m.id.startsWith('pending-assistant-') && !m.content)),
                    }
                  : s,
              )
            : state.sessions;
          if (streamingMessageId && activeSessionId) {
            updateSessionCache(newSessions);
          }
          useStreamingStore.getState().clearStreaming();
          return {
            sessions: newSessions,
          };
        });
        return;
      }

      console.log("[Session] Session error:", errorMsg);

      // Send desktop notification for non-abort errors
      const session = currentSessions.find((s) => s.id === event.sessionId);
      const sessionTitle = session?.title || "Session";
      const errorPreview = errorMsg.slice(0, 150) || "An error occurred";

      const errorSessionId = event.sessionId || activeSessionId || "";
      notificationService.send(
        "action_required",
        `${buildConfig.app.name} - ${sessionTitle}`,
        errorPreview,
        errorSessionId,
        async () => {
          try {
            await navigateToSession(errorSessionId);
            const appWindow = getCurrentWindow();
            await appWindow.setFocus();
            await appWindow.unminimize();
          } catch {
            // Ignore focus errors
          }
        },
      );

      clearRetryTimeout();
      clearMessageTimeout();

      set((state) => {
        const newSessions = activeSessionId
          ? state.sessions.map((s) =>
              s.id === activeSessionId
                ? {
                    ...s,
                    messages: s.messages
                      .map((m) => m.isStreaming ? { ...m, isStreaming: false } : m)
                      .filter((m) => !(m.id.startsWith('pending-assistant-') && !m.content)),
                  }
                : s,
            )
          : state.sessions;
        if (streamingMessageId && activeSessionId) {
          updateSessionCache(newSessions);
        }
        useStreamingStore.getState().clearStreaming();
        return {
          sessionError: event,
          sessions: newSessions,
        };
      });
    },

    // Clear session error
    clearSessionError: () => {
      set({ sessionError: null });
    },

    // Handle raw SSE events from child sessions (subagents)
    handleChildSessionEvent: (event: OpenCodeSSEEvent) => {
      const { type, properties } = event;

      if (type === "message.part.updated") {
        const part = properties.part as {
          id?: string;
          type?: string;
          sessionID?: string;
          tool?: string;
          state?: { status: string; title?: string };
        } | undefined;
        if (part?.id && part?.type) {
          childPartTypes.set(part.id, part.type);
        }

        // Update TaskToolCard summary for tool parts in child sessions
        const isToolPart = part?.type === "tool" || part?.type === "tool-call";
        if (isToolPart && part?.sessionID && part?.tool) {
          const { activeSessionId } = get();
          const { streamingMessageId } = useStreamingStore.getState();
          if (activeSessionId && streamingMessageId) {
            set((state) => {
              const session = getSessionById(activeSessionId);
              if (!session) return state;

              const msgIndex = session.messages.findIndex(m => m.id === streamingMessageId);
              if (msgIndex === -1) return state;

              const msg = session.messages[msgIndex];
              const taskToolCall = msg.toolCalls?.find(
                tc => tc.name === "task" && tc.metadata?.sessionId === part.sessionID,
              );
              if (!taskToolCall) return state;

              const summaryItem = {
                id: part.id!,
                tool: part.tool!,
                state: {
                  status: part.state?.status || "running",
                  title: part.state?.title,
                },
              };

              const currentSummary = taskToolCall.metadata?.summary || [];
              const existingIdx = currentSummary.findIndex(s => s.id === part.id);
              const newSummary = existingIdx >= 0
                ? currentSummary.map((s, i) => i === existingIdx ? summaryItem : s)
                : [...currentSummary, summaryItem];

              const updatedToolCalls = msg.toolCalls?.map(tc =>
                tc.name === "task" && tc.metadata?.sessionId === part.sessionID
                  ? { ...tc, metadata: { ...tc.metadata, summary: newSummary } }
                  : tc,
              );

              const newMsg = { ...msg, toolCalls: updatedToolCalls };
              const newMessages = [...session.messages];
              newMessages[msgIndex] = newMsg;
              const newSession = { ...session, messages: newMessages };
              sessionLookupCache.set(activeSessionId, newSession);

              return {
                sessions: state.sessions.map(s =>
                  s.id === activeSessionId ? newSession : s,
                ),
              };
            });
          }
        }
        return;
      }

      if (type === "message.part.delta") {
        const delta = properties as {
          sessionID?: string;
          partID?: string;
          delta?: string;
        };
        if (!delta.sessionID || !delta.delta) return;

        const partType =
          delta.partID ? childPartTypes.get(delta.partID) || "text" : "text";
        const buffer = childStreamingBuffers.get(delta.sessionID);
        if (!buffer) return;

        if (partType === "reasoning") {
          buffer.reasoning += delta.delta;
        } else {
          buffer.text += delta.delta;
        }
        scheduleChildStreamingFlush();
        return;
      }
    },
  };
}
