import { create } from "zustand";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";

function normalizeEngagedAgents(agents: AttachedAgent[]): AttachedAgent[] {
  return agents.length > 0 ? [agents[0]!] : [];
}

/** Per-session engaged agent (at most one). The prompt-input footer dock
 * renders a single agent pill; @-mentioning another agent replaces it. */
interface State {
  bySession: Record<string, AttachedAgent[]>;
  /** Replace the engaged-agents list for a session. */
  setAgents: (sessionId: string, agents: AttachedAgent[]) => void;
  /** Replace the engaged agent for a session. Used by @-mention. */
  addAgent: (sessionId: string, agent: AttachedAgent) => void;
  /** Remove an agent by id. */
  removeAgent: (sessionId: string, agentId: string) => void;
  /** Drop the whole entry for a session (e.g. on session delete). */
  clearSession: (sessionId: string) => void;
  /** Returns the array (empty if none / unknown sessionId). */
  getAgents: (sessionId: string | null) => AttachedAgent[];
  /** Legacy single-agent accessor — returns the first engaged agent or null.
   * Use {@link getAgents} for the full set when routing/rendering. */
  get: (sessionId: string | null) => AttachedAgent | null;
}

export const useEngagedAgentStore = create<State>((set, getState) => ({
  bySession: {},
  setAgents: (sessionId, agents) =>
    set((s) => ({
      bySession: { ...s.bySession, [sessionId]: normalizeEngagedAgents(agents) },
    })),
  addAgent: (sessionId, agent) =>
    set((s) => {
      const prev = s.bySession[sessionId] ?? [];
      if (prev.length === 1 && prev[0]?.id === agent.id) return s;
      return {
        bySession: { ...s.bySession, [sessionId]: [agent] },
      };
    }),
  removeAgent: (sessionId, agentId) =>
    set((s) => {
      const prev = s.bySession[sessionId];
      if (!prev || prev.length === 0) return s;
      const next = prev.filter((a) => a.id !== agentId);
      if (next.length === prev.length) return s;
      return {
        bySession: { ...s.bySession, [sessionId]: next },
      };
    }),
  clearSession: (sessionId) =>
    set((s) => {
      const nextBy = { ...s.bySession };
      delete nextBy[sessionId];
      return { bySession: nextBy };
    }),
  getAgents: (sessionId) =>
    sessionId
      ? normalizeEngagedAgents(getState().bySession[sessionId] ?? [])
      : [],
  get: (sessionId) => {
    if (!sessionId) return null;
    const arr = getState().bySession[sessionId];
    return arr && arr.length > 0 ? arr[0] : null;
  },
}));
