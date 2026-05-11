import { create } from "zustand";

export interface AgentStreamEntry {
  sessionId: string;
  actorId: string;
  outputText: string; // accumulated output deltas
  thinkingText: string; // accumulated thinking deltas
  lastUpdate: number; // ms epoch
  active: boolean; // true until final message.created arrives or status change resets it
}

interface State {
  // keyed by `${sessionId}::${actorId}`
  byKey: Record<string, AgentStreamEntry>;
  appendOutput: (sessionId: string, actorId: string, delta: string) => void;
  appendThinking: (sessionId: string, actorId: string, delta: string) => void;
  clearActor: (sessionId: string, actorId: string) => void;
  clearSession: (sessionId: string) => void;
}

function k(sessionId: string, actorId: string): string {
  return `${sessionId}::${actorId}`;
}

export const useV2StreamingStore = create<State>((set, get) => ({
  byKey: {},

  appendOutput: (sessionId, actorId, delta) => {
    if (!delta) return;
    const key = k(sessionId, actorId);
    const existing = get().byKey[key];
    set({
      byKey: {
        ...get().byKey,
        [key]: {
          sessionId,
          actorId,
          outputText: (existing?.outputText ?? "") + delta,
          thinkingText: existing?.thinkingText ?? "",
          lastUpdate: Date.now(),
          active: true,
        },
      },
    });
  },

  appendThinking: (sessionId, actorId, delta) => {
    if (!delta) return;
    const key = k(sessionId, actorId);
    const existing = get().byKey[key];
    set({
      byKey: {
        ...get().byKey,
        [key]: {
          sessionId,
          actorId,
          outputText: existing?.outputText ?? "",
          thinkingText: (existing?.thinkingText ?? "") + delta,
          lastUpdate: Date.now(),
          active: true,
        },
      },
    });
  },

  clearActor: (sessionId, actorId) => {
    const key = k(sessionId, actorId);
    const next = { ...get().byKey };
    delete next[key];
    set({ byKey: next });
  },

  clearSession: (sessionId) => {
    const next: Record<string, AgentStreamEntry> = {};
    for (const [key, entry] of Object.entries(get().byKey)) {
      if (entry.sessionId !== sessionId) next[key] = entry;
    }
    set({ byKey: next });
  },
}));

/** Selector helper: get all streaming entries for a session. */
export function selectStreamsForSession(state: State, sessionId: string): AgentStreamEntry[] {
  return Object.values(state.byKey).filter((e) => e.sessionId === sessionId && e.active);
}
