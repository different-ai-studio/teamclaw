import type { PermissionAskedEvent } from '@/lib/opencode/sdk-types';
import type { SessionState } from './session-types';
import type { StreamingState } from './streaming';
import { sessionLookupCache, getSessionById, updateSessionCache } from './session-cache';
import { useWorkspaceStore } from '@/stores/workspace';
import type { StoreApi } from 'zustand';

// Store references — set by session.ts after store creation to break circular dependency.
// All functions in this module access stores at call-time (inside setTimeout callbacks),
// so the references are guaranteed to be populated by the time they're used.
let sessionStoreRef: StoreApi<SessionState> | null = null;
let streamingStoreRef: StoreApi<StreamingState> | null = null;

export function setSessionStoreRef(store: StoreApi<SessionState>) {
  sessionStoreRef = store;
}

export function setStreamingStoreRef(store: StoreApi<StreamingState>) {
  streamingStoreRef = store;
}

// --- Session tracking ---

// Track session IDs created by the current app instance.
// When SSE fires session.created for one of these, we skip the full reload
// because the session is already in the local state (avoids the "disappearing session" bug).
export const selfCreatedSessionIds = new Set<string>();

// Set of session IDs currently being reloaded due to external messages.
// While a session is in this set, streaming SSE events (handleMessageCreated,
// handleMessagePartUpdated, etc.) are suppressed for that session.
export const externalReloadingSessions = new Set<string>();

// Set of session IDs where the AI is actively responding (session.status: busy).
// Used after external reload to resume streaming if the AI is still generating.
export const busySessions = new Set<string>();

// --- Permission buffer (race condition handling) ---

// Buffer for permissions that arrive before their matching tool call (SSE race condition).
// Keyed by callID. Drained in handleToolExecuting when the tool call is created.
export const pendingPermissionBuffer = new Map<string, PermissionAskedEvent>();

/**
 * Attach a PermissionAskedEvent to a tool call within the active session.
 * Returns true if the tool call was found and updated, false otherwise.
 */
export function attachPermissionToToolCall(
  event: PermissionAskedEvent,
): boolean {
  const targetSessionId = event.sessionID;
  if (!targetSessionId || !event.tool?.callID) return false;

  const session = getSessionById(targetSessionId);
  if (!session) return false;

  let found = false;
  const newMessages = session.messages.map((m) => {
    const tcIdx = m.toolCalls?.findIndex((tc) => tc.id === event.tool!.callID);
    if (tcIdx === undefined || tcIdx === -1) return m;
    found = true;
    const newToolCalls = [...(m.toolCalls || [])];
    newToolCalls[tcIdx] = {
      ...newToolCalls[tcIdx],
      permission: {
        id: event.id,
        permission: event.permission,
        patterns: event.patterns,
        metadata: event.metadata,
        always: event.always,
        decision: "pending",
      },
    };
    return { ...m, toolCalls: newToolCalls };
  });

  if (!found) return false;

  const newSession = { ...session, messages: newMessages };
  sessionLookupCache.set(targetSessionId, newSession);
  sessionStoreRef!.setState((s) => ({
    sessions: s.sessions.map((ss) =>
      ss.id === targetSessionId ? newSession : ss,
    ),
  }));
  return true;
}

// --- Debounce timers ---

let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
export const REFRESH_DEBOUNCE_MS = 300;

export const debouncedRefreshSessions = () => {
  if (sessionRefreshTimer) {
    clearTimeout(sessionRefreshTimer);
  }
  sessionRefreshTimer = setTimeout(() => {
    sessionRefreshTimer = null;
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    sessionStoreRef!.getState().loadSessions(workspacePath ?? undefined);
  }, REFRESH_DEBOUNCE_MS);
};

let messageReloadTimer: ReturnType<typeof setTimeout> | null = null;
export const MESSAGE_RELOAD_DEBOUNCE_MS = 500;

export const debouncedReloadMessages = (sessionId: string) => {
  // Mark this session as reloading — suppress SSE streaming events
  externalReloadingSessions.add(sessionId);

  if (messageReloadTimer) {
    clearTimeout(messageReloadTimer);
  }
  messageReloadTimer = setTimeout(async () => {
    messageReloadTimer = null;
    await sessionStoreRef!.getState().reloadActiveSessionMessages();
    // Clear the suppression flag after reload completes
    externalReloadingSessions.delete(sessionId);
  }, MESSAGE_RELOAD_DEBOUNCE_MS);
};

// --- Message timeout tracking ---

let messageTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
export const MESSAGE_TIMEOUT_MS = 300000; // 5 minutes timeout for OpenCode to start responding (supports long-running tasks)

export const clearMessageTimeout = () => {
  if (messageTimeoutTimer) {
    clearTimeout(messageTimeoutTimer);
    messageTimeoutTimer = null;
  }
};

export const setMessageTimeout = (pendingMessageId: string, sessionId: string) => {
  clearMessageTimeout();
  messageTimeoutTimer = setTimeout(() => {
    messageTimeoutTimer = null;
    const { streamingMessageId } = streamingStoreRef!.getState();
    const { activeSessionId } = sessionStoreRef!.getState();
    // Only clear if this is still the streaming message and no response received
    if (streamingMessageId === pendingMessageId && activeSessionId === sessionId) {
      console.warn("[Session] Message timeout - no response from OpenCode");
      busySessions.delete(sessionId);
      streamingStoreRef!.getState().clearStreaming();
      sessionStoreRef!.setState((state) => {
        const newSessions = state.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === pendingMessageId ? { ...m, isStreaming: false } : m,
                ),
              }
            : s,
        );
        updateSessionCache(newSessions);
        return {
          sessions: newSessions,
          error: "Message timeout - OpenCode server did not respond. Please check if the server is running.",
        };
      });
    }
  }, MESSAGE_TIMEOUT_MS);
};
