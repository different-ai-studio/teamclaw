import { create } from "zustand";
import { useSessionListStore } from "./session-list-store";

type SessionSelectionState = {
  activeSessionId: string | null;
  currentSessionId: string | null;
  viewingArchivedSessionId: string | null;
  viewingChildSessionId: string | null;
  setCurrent: (sessionId: string | null) => void;
  setActiveSession: (sessionId: string | null) => Promise<void>;
  clearActiveSession: () => void;
  setViewingArchivedSession: (sessionId: string | null) => void;
  setViewingChildSession: (sessionId: string | null) => void;
};

export const useSessionSelectionStore = create<SessionSelectionState>((set) => ({
  activeSessionId: null,
  currentSessionId: null,
  viewingArchivedSessionId: null,
  viewingChildSessionId: null,
  setCurrent: (sessionId) => {
    set({ activeSessionId: sessionId, currentSessionId: sessionId });
  },
  setActiveSession: async (sessionId) => {
    set({
      activeSessionId: sessionId,
      currentSessionId: sessionId,
      viewingArchivedSessionId: null,
      viewingChildSessionId: null,
    });
    if (sessionId) {
      await useSessionListStore.getState().markSessionViewed(sessionId);
    }
  },
  clearActiveSession: () => {
    set({
      activeSessionId: null,
      currentSessionId: null,
      viewingArchivedSessionId: null,
      viewingChildSessionId: null,
    });
  },
  setViewingArchivedSession: (sessionId) => set({ viewingArchivedSessionId: sessionId }),
  setViewingChildSession: (sessionId) => set({ viewingChildSessionId: sessionId }),
}));
