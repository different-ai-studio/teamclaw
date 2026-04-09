import { create } from "zustand";
import type { SessionState } from "./session-types";
import { UI_PAGE_SIZE, getSessionById } from "./session-cache";
import {
  setSessionStoreRef,
  setStreamingStoreRef,
} from "./session-internals";
import { useStreamingStore } from "@/stores/streaming";
import { createLoaderActions } from "./session-loader";
import { createMessageActions } from "./session-messages";
import { createSSEHandlers } from "./session-sse-handlers";
import { createPermissionActions } from "./session-permissions";
import { createQuestionActions } from "./session-questions";
import {
  loadPinnedSessionIds,
  savePinnedSessionIds,
} from "./session-pins";
import { getOpenCodeClient } from "@/lib/opencode/sdk-client";
import { convertMessage } from "./session-converters";

export const useSessionStore = create<SessionState>((set, get) => ({
  // Initial state
  sessions: [],
  pinnedSessionIds: loadPinnedSessionIds(),
  activeSessionId: null,
  isLoading: false,
  isLoadingMore: false,
  hasMoreSessions: false,
  visibleSessionCount: UI_PAGE_SIZE,
  error: null,
  isConnected: false,
  selectedModel: null,
  messageQueue: [],
  pendingPermissions: [],
  pendingQuestions: [],
  todos: [],
  sessionDiff: [],
  sessionError: null,
  sessionStatus: null,
  inactivityWarning: false,
  highlightedSessionIds: [],
  draftInput: "",
  viewingChildSessionId: null,
  childSessionMessages: {},
  isLoadingChildMessages: false,
  dashboardLoading: false,
  dashboardLoadProgress: { loaded: 0, total: 0 },
  dashboardLoadError: undefined,

  // Compose all action creators
  ...createLoaderActions(set, get),
  ...createMessageActions(set, get),
  ...createSSEHandlers(set, get),
  ...createPermissionActions(set, get),
  ...createQuestionActions(set, get),

  // Simple state setters
  toggleSessionPinned: (id: string) => {
    set((state) => {
      const exists = state.sessions.some((session) => session.id === id);
      if (!exists) return {};

      const pinnedSessionIds = state.pinnedSessionIds.includes(id)
        ? state.pinnedSessionIds.filter((sessionId) => sessionId !== id)
        : [id, ...state.pinnedSessionIds];

      savePinnedSessionIds(pinnedSessionIds);
      return { pinnedSessionIds };
    });
  },
  setConnected: (connected: boolean) => {
    set({ isConnected: connected });
  },
  setError: (error: string | null) => {
    set({ error });
  },
  setInactivityWarning: (active: boolean) => {
    set({ inactivityWarning: active });
  },

  // Child session viewing
  setViewingChildSession: (sessionId: string | null) => {
    set({ viewingChildSessionId: sessionId });
    if (sessionId && !get().childSessionMessages[sessionId]) {
      get().loadChildSessionMessages(sessionId);
    }
  },
  loadChildSessionMessages: async (sessionId: string) => {
    set({ isLoadingChildMessages: true });
    try {
      const client = getOpenCodeClient();
      const rawMessages = await client.getMessages(sessionId);
      const converted = rawMessages.map(convertMessage);
      set((s) => ({
        childSessionMessages: { ...s.childSessionMessages, [sessionId]: converted },
        isLoadingChildMessages: false,
      }));
    } catch (err) {
      console.error("[Session] Failed to load child session messages:", err);
      set({ isLoadingChildMessages: false });
    }
  },

  // Getters
  getActiveSession: () => {
    const state = get();
    if (!state.activeSessionId) return undefined;
    return getSessionById(state.activeSessionId);
  },
  getSessionMessages: (sessionId: string) => {
    const session = getSessionById(sessionId);
    return session?.messages || [];
  },
}));

// Initialize store refs for session-internals.ts (breaks circular dependency)
setSessionStoreRef(useSessionStore);
setStreamingStoreRef(useStreamingStore);
