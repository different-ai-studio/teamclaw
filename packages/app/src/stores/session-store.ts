import { create } from "zustand";
import type { Message } from "@/lib/proto/teamclaw_pb";
import { useSessionListStore } from "./session-list-store";

// ────────────────────────────────────────────────────────────────────
// v2 Phase 1 compat shim.
//
// Phase 1E removed the OpenCode-era session store but left ~167
// `@ts-expect-error Phase 1E removal` references across 26 production
// files (AppSidebar, ChatPanel, SessionList, etc) that read fields and
// call methods which no longer exist. Those calls crash on render.
//
// Until Phase 2 rewrites those consumers against the lean v2 stores,
// this shim exposes safe defaults so the app boots and the smoke-test
// path (login → pick session → send → MQTT round-trip) is reachable.
// Compat fields are typed as `any` via the Record<string, Compat>
// overlay so consumers compile without enumerating every prop. v2
// native fields keep their real types.
// ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Compat = any;

// Stable empty references so selectors like `s.currentMessages()` don't
// return a new `[]` identity each call — React's useSyncExternalStore
// treats that as a tear and infinite-loops.
const EMPTY_MESSAGES: Message[] = [];

type V2Native = {
  messages: Record<string, Message[]>;
  currentSessionId: string | null;
  /** Bumped by reloadActiveSessionMessages so the App.tsx history loader
   * effect can detect a user-driven refresh and force a full pull. */
  messageRefreshTrigger: number;
  setCurrent: (sid: string | null) => void;
  appendMessage: (sid: string, msg: Message) => void;
  setMessages: (sid: string, msgs: Message[]) => void;
  currentMessages: () => Message[];
};

// Phase 1E compat fields explicitly typed so consumers' .map / .filter /
// .includes / [] indexing pass typecheck without per-callsite annotations.
// `Compat` (= any) keeps element shapes loose since the v1 shape is gone.
type CompatExplicit = {
  sessions: Compat[];
  archivedSessions: Compat[];
  pinnedSessionIds: string[];
  highlightedSessionIds: string[];
  pendingPermissions: Compat[];
  pendingQuestions: Compat[];
  messageQueue: Compat[];
  cronSessionIds: string[];
  sessionDiff: Compat[];
  pendingQuestionIdsBySession: Record<string, Compat>;
  sessionStatuses: Record<string, Compat>;
  isLoadingChildMessages: Record<string, boolean>;
  childSessionStreaming: Record<string, Compat>;
  todos: Compat[];
};

type SessionState = V2Native & CompatExplicit & { [key: string]: Compat };

const stub = (name: string) => (...args: Compat[]) => {
  if (typeof console !== "undefined") {
    console.warn(`[session-store stub] ${name} called (no-op in v2)`, args);
  }
};
const stubAsync = (name: string) => async (...args: Compat[]) => {
  if (typeof console !== "undefined") {
    console.warn(`[session-store stub] ${name} called (no-op in v2)`, args);
  }
};

export const useSessionStore = create<SessionState>((set, get) => ({
  // ── v2 native ────────────────────────────────────────────────────
  messages: {},
  currentSessionId: null,
  messageRefreshTrigger: 0,
  setCurrent: (sid) => set({ currentSessionId: sid, activeSessionId: sid }),
  appendMessage: (sid, msg) => {
    const cur = get().messages[sid] ?? [];
    if (cur.some((m) => m.messageId === msg.messageId)) return;
    set({ messages: { ...get().messages, [sid]: [...cur, msg] } });
  },
  setMessages: (sid, msgs) => set({ messages: { ...get().messages, [sid]: msgs } }),
  currentMessages: () => {
    const sid = get().currentSessionId;
    if (!sid) return EMPTY_MESSAGES;
    return get().messages[sid] ?? EMPTY_MESSAGES;
  },

  // ── Phase 1E compat: read-field defaults ─────────────────────────
  sessions: [],
  archivedSessions: [],
  activeSessionId: null,
  pinnedSessionIds: [],
  highlightedSessionIds: [],
  visibleSessionCount: 50,
  hasMoreSessions: false,
  isLoading: false,
  isLoadingMore: false,
  isLoadingArchivedSessions: false,
  archivedSessionError: null,
  sessionError: null,
  errorSessionId: null,
  inactivityWarning: null,
  isConnected: true,
  isLoadingChildMessages: {},
  childSessionStreaming: {},
  viewingArchivedSessionId: null,
  viewingChildSessionId: null,
  draftInput: "",
  messageQueue: [],
  pendingPermissions: [],
  pendingQuestions: [],
  pendingQuestionIdsBySession: {},
  sessionStatuses: {},
  sessionStatus: null,
  cronSessionIds: [],
  todos: [],
  sessionDiff: [],

  // ── Phase 1E compat: methods with light wiring ───────────────────
  getActiveSession: () => {
    const sid = get().currentSessionId ?? get().activeSessionId;
    if (!sid) return null;
    return get().sessions.find((s: Compat) => s.id === sid) ?? null;
  },
  setActiveSession: async (sid: string | null) => {
    set({ currentSessionId: sid, activeSessionId: sid });
  },
  loadSessions: async () => {
    await useSessionListStore.getState().load();
  },
  reloadActiveSessionMessages: async () => {
    // Refresh the session list AND signal the App.tsx history-loader
    // effect to do a full (non-watermark) pull for the active session.
    await useSessionListStore.getState().load();
    set({ messageRefreshTrigger: (get().messageRefreshTrigger ?? 0) + 1 });
  },
  resetSessions: () =>
    set({ sessions: [], activeSessionId: null, currentSessionId: null }),
  setDraftInput: (text: string) => set({ draftInput: text }),
  setError: (msg: string | null, sid?: string | null) =>
    set({ sessionError: msg, errorSessionId: sid ?? null }),
  clearSessionError: () => set({ sessionError: null, errorSessionId: null }),
  toggleSessionPinned: (sid: string) => {
    const cur = get().pinnedSessionIds as string[];
    set({
      pinnedSessionIds: cur.includes(sid)
        ? cur.filter((id) => id !== sid)
        : [...cur, sid],
    });
  },
  setSelectedModel: (model: Compat) => set({ selectedModel: model }),
  setViewingChildSession: (sid: string | null) => set({ viewingChildSessionId: sid }),
  setConnected: (v: boolean) => set({ isConnected: v }),
  setInactivityWarning: (v: Compat) => set({ inactivityWarning: v }),

  // ── Phase 1E compat: pure stubs (no v2 implementation yet) ───────
  archiveSession: stubAsync("archiveSession"),
  updateSessionTitle: stubAsync("updateSessionTitle"),
  loadMoreSessions: stubAsync("loadMoreSessions"),
  loadArchivedSessions: stubAsync("loadArchivedSessions"),
  openArchivedSession: stubAsync("openArchivedSession"),
  closeArchivedSession: stub("closeArchivedSession"),
  restoreSession: stubAsync("restoreSession"),
  abortSession: stubAsync("abortSession"),
  sendMessage: stubAsync("sendMessage"),
  removeFromQueue: stub("removeFromQueue"),
  pollPermissions: stubAsync("pollPermissions"),
  replyPermission: stubAsync("replyPermission"),
  answerQuestion: stubAsync("answerQuestion"),
  skipQuestion: stubAsync("skipQuestion"),
  getSessionMessages: () => [],
  loadAllSessionMessages: stubAsync("loadAllSessionMessages"),
  handleMessageCreated: stub("handleMessageCreated"),
  handleMessagePartCreated: stub("handleMessagePartCreated"),
  handleMessagePartUpdated: stub("handleMessagePartUpdated"),
  handleMessageCompleted: stub("handleMessageCompleted"),
  handleToolExecuting: stub("handleToolExecuting"),
  handlePermissionAsked: stub("handlePermissionAsked"),
  handleQuestionAsked: stub("handleQuestionAsked"),
  handleTodoUpdated: stub("handleTodoUpdated"),
  handleSessionDiff: stub("handleSessionDiff"),
  handleFileEdited: stub("handleFileEdited"),
  handleSessionError: stub("handleSessionError"),
  handleSessionCreated: stub("handleSessionCreated"),
  handleSessionUpdated: stub("handleSessionUpdated"),
  handleExternalMessage: stub("handleExternalMessage"),
  handleSessionStatus: stub("handleSessionStatus"),
  handleSessionBusy: stub("handleSessionBusy"),
  handleSessionIdle: stub("handleSessionIdle"),
  handleChildSessionEvent: stub("handleChildSessionEvent"),
}));

// Adapt v2 SessionListEntry → old Session shape so consumers that read
// .updatedAt / .createdAt / .messages / .parentID don't crash.
function adaptSessionRow(r: Compat): Compat {
  const ts = r.last_message_at
    ? new Date(r.last_message_at)
    : new Date(0);
  return {
    ...r,
    updatedAt: ts,
    createdAt: ts,
    messages: [],
    parentID: null,
  };
}

// Mirror useSessionListStore.rows → useSessionStore.sessions so old
// consumers reading `s.sessions` see a reactive list. Only push when
// values actually changed to avoid unnecessary re-render cascades.
useSessionListStore.subscribe((state, prev) => {
  const updates: Partial<SessionState> = {};
  if (state.rows !== prev.rows) updates.sessions = state.rows.map(adaptSessionRow);
  if (state.loading !== prev.loading) updates.isLoading = state.loading;
  if (Object.keys(updates).length > 0) {
    useSessionStore.setState(updates);
  }
});
{
  const initial = useSessionListStore.getState();
  useSessionStore.setState({
    sessions: initial.rows.map(adaptSessionRow),
    isLoading: initial.loading,
  });
}
