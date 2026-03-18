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

export const useSessionStore = create<SessionState>((set, get) => ({
  // Initial state
  sessions: [],
  activeSessionId: null,
  isLoading: false,
  isLoadingMore: false,
  hasMoreSessions: false,
  visibleSessionCount: UI_PAGE_SIZE,
  error: null,
  isConnected: false,
  selectedModel: null,
  messageQueue: [],
  pendingPermission: null,
  pendingPermissionChildSessionId: null,
  pendingQuestion: null,
  todos: [],
  sessionDiff: [],
  sessionError: null,
  sessionStatus: null,
  inactivityWarning: false,
  highlightedSessionIds: [],
  draftInput: "",
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
  setConnected: (connected: boolean) => {
    set({ isConnected: connected });
  },
  setError: (error: string | null) => {
    set({ error });
  },
  setInactivityWarning: (active: boolean) => {
    set({ inactivityWarning: active });
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
