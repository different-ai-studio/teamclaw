import { getOpenCodeClient } from "@/lib/opencode/client";
import type { Todo, FileDiff } from "@/lib/opencode/types";
import { notificationService } from "@/lib/notification-service";
import { useProviderStore } from "@/stores/provider";
import type {
  Message,
  Session,
  SelectedModel,
  SessionState,
} from "./session-types";
import { convertMessage, convertSession, convertSessionListItem } from "./session-converters";
import {
  sessionLookupCache,
  getSessionById,
  updateSessionCache,
  UI_PAGE_SIZE,
} from "./session-cache";
import {
  selfCreatedSessionIds,
  busySessions,
} from "./session-internals";
import {
  useStreamingStore,
  cleanupAllChildSessions,
} from "@/stores/streaming";
import { trackEvent } from "@/stores/telemetry";
import { sessionDataCache } from "./session-data-cache";

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

export function createLoaderActions(set: SessionSet, get: SessionGet) {
  return {
    // Reset sessions (clear all session data and cache)
    resetSessions: () => {
      sessionDataCache.clear();
      sessionLookupCache.clear();
      cleanupAllChildSessions();
      useStreamingStore.getState().clearStreaming();
      set({
        sessions: [],
        activeSessionId: null,
        messageQueue: [],
        pendingPermission: null,
        pendingPermissionChildSessionId: null,
        pendingQuestion: null,
        todos: [],
        sessionDiff: [],
        sessionError: null,
        sessionStatus: null,
        highlightedSessionIds: [],
        isLoadingMore: false,
        hasMoreSessions: false,
        visibleSessionCount: UI_PAGE_SIZE,
      });
    },

    // Set selected model
    setSelectedModel: (model: SelectedModel | null) => {
      set({ selectedModel: model });
    },

    // Draft input actions
    setDraftInput: (input: string) => {
      set({ draftInput: input });
    },
    clearDraftInput: () => {
      set({ draftInput: "" });
    },

    // Load all sessions from OpenCode, filtered by workspace directory
    loadSessions: async (workspacePath?: string) => {
      set({ isLoading: true, error: null, isLoadingMore: false });
      try {
        const client = getOpenCodeClient();
        const sessions = await client.listSessions(
          workspacePath
            ? { directory: workspacePath, roots: true }
            : { roots: true },
        );

        // Filter out archived, child, and internal sessions
        const activeSessions = sessions.filter(
          (session) =>
            !session.time?.archived &&
            !session.parentID,
        );
        const filteredCount = sessions.length - activeSessions.length;
        if (filteredCount > 0) {
          console.log("[Session] Filtered out archived/child/internal sessions:", filteredCount);
        }

        console.log(
          "[Session] Loaded sessions for workspace:",
          workspacePath,
          `(${activeSessions.length} active sessions)`,
        );

        // Debug: Log first few session titles to detect issues
        if (activeSessions.length > 0) {
          console.log("[Session] First 3 session titles:", activeSessions.slice(0, 3).map(s => ({ id: s.id.substring(0, 10), title: s.title })));
        }

        // Preserve existing messages when updating sessions list
        const existingSessions = get().sessions;
        const existingMessagesMap = new Map(
          existingSessions.map((s) => [s.id, s.messages]),
        );

        const newSessions = activeSessions.map((item) => {
          const converted = convertSessionListItem(item);
          const existingMessages = existingMessagesMap.get(item.id);
          return existingMessages && existingMessages.length > 0
            ? { ...converted, messages: existingMessages }
            : converted;
        });

        // Sort by updatedAt descending (most recently active first)
        newSessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

        // UI-level pagination: initially show first PAGE_SIZE sessions
        const hasMore = newSessions.length > UI_PAGE_SIZE;

        set({
          sessions: newSessions,
          isLoading: false,
          hasMoreSessions: hasMore,
          visibleSessionCount: Math.min(newSessions.length, UI_PAGE_SIZE),
        });

        // Update lookup cache after loading sessions
        updateSessionCache(newSessions);
      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : "Failed to load sessions",
          isLoading: false,
          hasMoreSessions: false,
        });
      }
    },

    // Show more sessions in the sidebar (UI-level pagination, no API call)
    loadMoreSessions: async () => {
      const { sessions, visibleSessionCount, hasMoreSessions } = get();
      if (!hasMoreSessions) return;

      const newVisible = Math.min(visibleSessionCount + UI_PAGE_SIZE, sessions.length);
      set({
        visibleSessionCount: newVisible,
        hasMoreSessions: newVisible < sessions.length,
      });

      console.log(
        "[Session] Showing more sessions:",
        newVisible,
        "of",
        sessions.length,
      );
    },

    // Create a new session
    createSession: async (_workspacePath?: string) => {
      // Save current session's message queue and pending question to cache before creating new session
      const { activeSessionId: prevSessionId, messageQueue: currentQueue, pendingQuestion: currentPendingQuestion } = get();
      if (prevSessionId) {
        const prevCached = sessionDataCache.get(prevSessionId) || { todos: [], diff: [] };
        sessionDataCache.set(prevSessionId, {
          ...prevCached,
          messageQueue: currentQueue.length > 0 ? currentQueue : prevCached.messageQueue,
          pendingQuestion: currentPendingQuestion,
        });
      }

      set({ isLoading: true, error: null });
      try {
        const client = getOpenCodeClient();
        const newSession = await client.createSession();

        const session = convertSession(newSession);

        trackEvent('session_started');

        // Track as self-created so SSE handler skips the full reload
        selfCreatedSessionIds.add(session.id);

        // First update: Add session and set as active (with isLoading: true)
        set((state) => {
          const newSessions = [session, ...state.sessions];
          updateSessionCache(newSessions);

          cleanupAllChildSessions();
          useStreamingStore.getState().clearStreaming();
          return {
            sessions: newSessions,
            activeSessionId: session.id,
            isLoading: true,
            messageQueue: [],
            todos: [],
            sessionDiff: [],
            sessionError: null,
            sessionStatus: null,
            pendingQuestion: null,
          };
        });

        // Second update: Set isLoading to false to trigger UI update
        set({ isLoading: false });

        return session;
      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : "Failed to create session",
          isLoading: false,
        });
        return null;
      }
    },

    // Set active session and load its messages
    setActiveSession: async (id: string) => {
      const {
        activeSessionId: prevSessionId,
        todos: currentTodos,
        sessionDiff: currentDiff,
        messageQueue: currentQueue,
        pendingQuestion: currentPendingQuestion,
      } = get();

      // Save current session's todos, diff, message queue, and pending question to cache before switching
      if (prevSessionId) {
        const prevCached = sessionDataCache.get(prevSessionId) || { todos: [], diff: [] };
        sessionDataCache.set(prevSessionId, {
          todos: currentTodos.length > 0 ? currentTodos : prevCached.todos,
          diff: currentDiff.length > 0 ? currentDiff : prevCached.diff,
          messageQueue: currentQueue.length > 0 ? currentQueue : undefined,
          pendingQuestion: currentPendingQuestion,
        });
      }

      // Restore todos, diff, message queue, and pending question from cache for the new session
      const cachedData = sessionDataCache.get(id);

      // Reset streaming state and restore session-specific data when switching sessions
      cleanupAllChildSessions();
      useStreamingStore.getState().clearStreaming();
      // Sync active session to notification service so it can suppress
      // notifications for the session the user is currently looking at
      notificationService.activeSessionId = id;

      set({
        activeSessionId: id,
        isLoading: true,
        messageQueue: cachedData?.messageQueue || [],
        todos: cachedData?.todos || [],
        sessionDiff: cachedData?.diff || [],
        sessionError: null,
        sessionStatus: null,
        pendingPermission: null,
        pendingPermissionChildSessionId: null,
        pendingQuestion: cachedData?.pendingQuestion || null,
      });

      try {
        const client = getOpenCodeClient();

        // Fetch messages, session info, todos, and session-specific diffs in parallel
        const [messages, sessionInfo, todosData, diffsData] = await Promise.all([
          client.getMessages(id),
          client.getSession(id).catch(() => null),
          client.getTodos(id).catch(() => []),
          client.getSessionDiff(id).catch(() => []),
        ]);

        console.log("[Session] Session info:", sessionInfo);
        console.log("[Session] Session summary:", sessionInfo?.summary);
        console.log("[Session] Diff endpoint response:", diffsData);

        // Convert todos to our format
        const todos: Todo[] = todosData.map((t) => ({
          id: t.id,
          content: t.content,
          status: t.status as
            | "pending"
            | "in_progress"
            | "completed"
            | "cancelled",
          priority: t.priority as "high" | "medium" | "low",
        }));

        // Get diffs from diff endpoint or session summary (NOT from global fileStatus)
        let rawDiffs: Array<{
          file: string;
          before?: string;
          after?: string;
          additions?: number;
          deletions?: number;
        }> = [];

        if (diffsData.length > 0) {
          rawDiffs = diffsData;
        } else if (
          sessionInfo?.summary?.diffs &&
          sessionInfo.summary.diffs.length > 0
        ) {
          rawDiffs = sessionInfo.summary.diffs;
        }
        console.log("[Session] Raw diffs (session-specific):", rawDiffs);

        // Convert diffs to our format
        const diffs: FileDiff[] = rawDiffs.map((d) => ({
          file: d.file,
          before: d.before || "",
          after: d.after || "",
          additions: d.additions || 0,
          deletions: d.deletions || 0,
        }));
        console.log("[Session] Processed diffs:", diffs.length);

        // Update cache with fetched data
        if (todos.length > 0 || diffs.length > 0) {
          const cached = sessionDataCache.get(id) || { todos: [], diff: [] };
          sessionDataCache.set(id, {
            todos: todos.length > 0 ? todos : cached.todos,
            diff: diffs.length > 0 ? diffs : cached.diff,
          });
        }

        // Detect model from the last assistant or user message in this session
        let detectedModel: SelectedModel | null = null;

        const providerState = useProviderStore.getState();
        console.log("[Session] Available models in provider store:", providerState.models.length);

        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          console.log(`[Session] Checking message ${i}:`, {
            role: msg.info.role,
            modelID: msg.info.modelID,
            providerID: msg.info.providerID
          });

          if (msg.info.modelID && msg.info.providerID) {
            const modelOption = providerState.models.find(
              (m) => m.provider === msg.info.providerID && m.id === msg.info.modelID
            );

            detectedModel = {
              providerID: msg.info.providerID,
              modelID: msg.info.modelID,
              name: modelOption?.name || `${msg.info.providerID}/${msg.info.modelID}`,
            };
            console.log("[Session] Detected model from message:", detectedModel, "modelOption:", modelOption);
            break;
          }
        }

        if (!detectedModel) {
          console.log("[Session] No model detected from messages");
        }

        set((state) => {
          // Get current session to preserve local-only fields
          const currentSession = getSessionById(id);
          const oldMessagesMap = new Map(
            currentSession?.messages.map((m) => [m.id, m]) || []
          );

          // Convert messages and merge with local-only fields (like retrievedChunks)
          const convertedMessages = messages.map(convertMessage);

          // Build arrays of old/new user messages for position-based matching
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

          // Check for duplicate message IDs
          const messageIds = sortedMerged.map(m => m.id);
          const uniqueIds = new Set(messageIds);
          if (messageIds.length !== uniqueIds.size) {
            console.error("[Session] Duplicate message IDs detected!", {
              total: messageIds.length,
              unique: uniqueIds.size,
              duplicates: messageIds.filter((id, index) => messageIds.indexOf(id) !== index)
            });
          }

          const newSessions = state.sessions.map((s) =>
            s.id === id ? { ...s, messages: sortedMerged } : s,
          );
          updateSessionCache(newSessions);

          const isStillActive = state.activeSessionId === id;

          // Sync detected model to provider store
          if (isStillActive && detectedModel) {
            const modelKey = `${detectedModel.providerID}/${detectedModel.modelID}`;
            useProviderStore.setState({ currentModelKey: modelKey });
            localStorage.setItem('teamclaw-selected-model', modelKey);
            console.log("[Session] Synced model to provider store:", modelKey);
          }

          const base = {
            sessions: newSessions,
            todos: isStillActive ? todos : state.todos,
            sessionDiff: isStillActive ? diffs : state.sessionDiff,
            isLoading: isStillActive ? false : state.isLoading,
            selectedModel: isStillActive && detectedModel ? detectedModel : state.selectedModel,
          };

          // If this session is busy (AI still responding), resume streaming UI
          if (isStillActive && busySessions.has(id) && sortedMerged.length > 0) {
            const lastMsg = sortedMerged[sortedMerged.length - 1];

            const lastApiMsg = messages[messages.length - 1];
            const isMessageComplete = lastApiMsg?.info?.time?.completed != null;

            console.log("[Session] Busy session check:", {
              sessionId: id,
              lastMsgId: lastMsg.id,
              lastMsgRole: lastMsg.role,
              hasCompletedTime: isMessageComplete,
              completedValue: lastApiMsg?.info?.time?.completed,
              apiMsgInfo: lastApiMsg?.info
            });

            if (lastMsg.role === "assistant" && !isMessageComplete) {
              console.log("[Session] Session is busy after switch, resuming streaming for:", lastMsg.id);
              const sessionsWithStreaming = newSessions.map((s) =>
                s.id === id
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
                ...base,
                sessions: sessionsWithStreaming,
              };
            } else if (isMessageComplete) {
              console.log("[Session] Session marked busy but last message already completed, not resuming streaming");
              busySessions.delete(id);
            }
          }

          return base;
        });

      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : "Failed to load messages",
          isLoading: false,
        });
      }
    },

    // Archive a session
    archiveSession: async (id: string) => {
      try {
        const client = getOpenCodeClient();
        const session = get().sessions.find((s) => s.id === id);
        const directory = session?.directory;
        await client.archiveSession(id, directory);

        // Clean up cache for archived session
        sessionDataCache.delete(id);

        set((state) => {
          const newSessions = state.sessions.filter((s) => s.id !== id);
          updateSessionCache(newSessions);

          return {
            sessions: newSessions,
            activeSessionId:
              state.activeSessionId === id
                ? (newSessions[0]?.id ?? null)
                : state.activeSessionId,
          };
        });
      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : "Failed to archive session",
        });
      }
    },

    updateSessionTitle: async (id: string, title: string) => {
      try {
        const client = getOpenCodeClient();
        await client.updateSession(id, { title });

        set((state) => {
          const newSessions = state.sessions.map((s) =>
            s.id === id ? { ...s, title } : s
          );
          updateSessionCache(newSessions);

          return { sessions: newSessions };
        });
      } catch (error) {
        console.error("[Session] Failed to update session title:", error);
        set({
          error:
            error instanceof Error
              ? error.message
              : "Failed to update session title",
        });
        throw error;
      }
    },

    // Dashboard batch loading: load messages for all sessions
    loadAllSessionMessages: async (workspacePath?: string) => {
      const { dashboardLoading } = get();
      if (dashboardLoading) return;

      set({ dashboardLoading: true, dashboardLoadError: undefined, dashboardLoadProgress: { loaded: 0, total: 0 } });

      try {
        const client = getOpenCodeClient();

        const allSessions = await client.listSessions(
          workspacePath ? { directory: workspacePath, roots: true } : { roots: true },
        );

        const activeSessions = allSessions.filter(
          (s) => !s.time?.archived,
        );

        const existingSessions = get().sessions;
        const existingMessagesMap = new Map(
          existingSessions.map((s) => [s.id, s.messages]),
        );

        const sessionsNeedingMessages = activeSessions.filter((s) => {
          const existing = existingMessagesMap.get(s.id);
          return !existing || existing.length === 0;
        });

        const total = activeSessions.length;
        let loaded = total - sessionsNeedingMessages.length;
        set({ dashboardLoadProgress: { loaded, total } });

        const CONCURRENCY = 5;
        const errors: string[] = [];

        for (let i = 0; i < sessionsNeedingMessages.length; i += CONCURRENCY) {
          const batch = sessionsNeedingMessages.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async (session) => {
              const messages = await client.getMessages(session.id);
              return { sessionId: session.id, messages: messages.map(convertMessage) };
            }),
          );

          const successfulLoads: Array<{ sessionId: string; messages: Message[] }> = [];
          for (const result of results) {
            if (result.status === "fulfilled") {
              successfulLoads.push(result.value);
            } else {
              errors.push(result.reason?.message || "Unknown error");
            }
            loaded++;
          }

          if (successfulLoads.length > 0) {
            set((state) => {
              const newSessions = state.sessions.map((s) => {
                const loadedData = successfulLoads.find((l) => l.sessionId === s.id);
                if (!loadedData) return s;

                if (s.messages.length > 0) {
                  const oldMessagesMap = new Map(
                    s.messages.map((m) => [m.id, m])
                  );

                  const oldUserMessages = s.messages.filter(m => m.role === 'user');
                  const newUserMessages = loadedData.messages.filter(m => m.role === 'user');

                  const mergedMessages = loadedData.messages.map((newMsg) => {
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
                  return { ...s, messages: mergedMessages };
                }

                return { ...s, messages: loadedData.messages };
              });

              const existingIds = new Set(state.sessions.map((s) => s.id));
              const newSessionsToAdd = successfulLoads
                .filter((l) => !existingIds.has(l.sessionId))
                .map((l) => {
                  const sessionData = activeSessions.find((s) => s.id === l.sessionId);
                  if (!sessionData) return null;
                  return {
                    id: sessionData.id,
                    title: sessionData.title || "New Chat",
                    messages: l.messages,
                    createdAt: new Date(sessionData.time.created),
                    updatedAt: new Date(sessionData.time.updated),
                    directory: sessionData.directory,
                    parentID: sessionData.parentID,
                  } as Session;
                })
                .filter((s): s is Session => s !== null);

              const allSessionsList = [...newSessions, ...newSessionsToAdd];
              updateSessionCache(allSessionsList);

              return {
                sessions: allSessionsList,
                dashboardLoadProgress: { loaded, total },
              };
            });
          } else {
            set({ dashboardLoadProgress: { loaded, total } });
          }
        }

        set({
          dashboardLoading: false,
          dashboardLoadError: errors.length > 0
            ? `Failed to load ${errors.length} session(s)`
            : undefined,
        });
      } catch (error) {
        set({
          dashboardLoading: false,
          dashboardLoadError: error instanceof Error ? error.message : "Failed to load sessions",
        });
      }
    },
  };
}
