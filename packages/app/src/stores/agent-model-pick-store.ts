import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Per-(session, agent) model selection store.
 *
 * Design contract — read this before adding writers:
 *
 *  - A pick is ALWAYS a user-initiated choice from the agent pill. There is no
 *    other writer. Daemon MQTT retains MUST NOT call setPick — they expose
 *    `RuntimeInfo.currentModel` separately, and `selectAgentModel` does the
 *    reconciliation at read time. Mixing the two causes the "selected model
 *    keeps reverting to Big Pickle" bug.
 *
 *  - A pick wins over MQTT retain for both UI display and outbound setModel /
 *    runtimeStart payloads. The only way to lose a pick is to overwrite it
 *    with another pick or call clearPick.
 *
 *  - Persisted to localStorage so a page reload does not silently throw the
 *    user's pick away (one of the recurring "弹回" symptoms).
 */

function key(sessionId: string, agentId: string): string {
  return `${sessionId}::${agentId}`;
}

export type AgentModelPickEntry = {
  modelId: string;
};

interface State {
  bySessionAgent: Record<string, AgentModelPickEntry>;
  setPick: (sessionId: string, agentId: string, modelId: string) => void;
  getPick: (sessionId: string, agentId: string) => string | undefined;
  clearPick: (sessionId: string, agentId: string) => void;
  clearSession: (sessionId: string) => void;
}

export const useAgentModelPickStore = create<State>()(
  persist(
    (set, get) => ({
      bySessionAgent: {},
      setPick: (sessionId, agentId, modelId) => {
        const trimmed = modelId.trim();
        if (!sessionId || !agentId || !trimmed) return;
        set((s) => ({
          bySessionAgent: {
            ...s.bySessionAgent,
            [key(sessionId, agentId)]: { modelId: trimmed },
          },
        }));
      },
      getPick: (sessionId, agentId) => {
        if (!sessionId || !agentId) return undefined;
        return get().bySessionAgent[key(sessionId, agentId)]?.modelId;
      },
      clearPick: (sessionId, agentId) => {
        if (!sessionId || !agentId) return;
        set((s) => {
          const k = key(sessionId, agentId);
          if (!s.bySessionAgent[k]) return s;
          const next = { ...s.bySessionAgent };
          delete next[k];
          return { bySessionAgent: next };
        });
      },
      clearSession: (sessionId) =>
        set((s) => {
          const prefix = `${sessionId}::`;
          const next = { ...s.bySessionAgent };
          for (const k of Object.keys(next)) {
            if (k.startsWith(prefix)) delete next[k];
          }
          return { bySessionAgent: next };
        }),
    }),
    {
      name: "teamclaw.agent-model-pick.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ bySessionAgent: s.bySessionAgent }),
    },
  ),
);
