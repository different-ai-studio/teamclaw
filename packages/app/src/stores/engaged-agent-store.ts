import { create } from "zustand";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";

function normalizeEngagedAgents(agents: AttachedAgent[]): AttachedAgent[] {
  return agents.length > 0 ? [agents[0]!] : [];
}

/** Per-session engaged agent (at most one). The prompt-input footer dock
 * renders a single agent pill; @-mentioning another agent replaces it. */
interface State {
  bySession: Record<string, AttachedAgent[]>;
  /** True when the user actively removed the last agent from a session
   * ("Remove mention" in the pill dropdown). Send-time mention resolvers
   * read this to suppress the "auto-mention the sole session agent"
   * fallback — if the user explicitly cleared mentions, sending without
   * @ should NOT re-engage the agent. Reset by `addAgent`/`setAgents`
   * (non-empty) since re-engaging counts as new intent. */
  wasExplicitlyCleared: Record<string, boolean>;
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
  /** Legacy setter that replaces the list with [agent] (or clears when null). */
  setEngagedAgent: (sessionId: string, agent: AttachedAgent | null) => void;
}

export const useEngagedAgentStore = create<State>((set, getState) => ({
  bySession: {},
  wasExplicitlyCleared: {},
  setAgents: (sessionId, agents) =>
    set((s) => {
      const normalized = normalizeEngagedAgents(agents);
      return {
      bySession: { ...s.bySession, [sessionId]: normalized },
      wasExplicitlyCleared: {
        ...s.wasExplicitlyCleared,
        // Re-engaging (non-empty) clears the "explicitly empty" flag;
        // setAgents([]) is a programmatic reset (not user intent), keep flag.
        [sessionId]:
          normalized.length > 0 ? false : s.wasExplicitlyCleared[sessionId] ?? false,
      },
    };
    }),
  addAgent: (sessionId, agent) =>
    set((s) => {
      const prev = s.bySession[sessionId] ?? [];
      if (prev.length === 1 && prev[0]?.id === agent.id) return s;
      return {
        bySession: { ...s.bySession, [sessionId]: [agent] },
        wasExplicitlyCleared: { ...s.wasExplicitlyCleared, [sessionId]: false },
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
        wasExplicitlyCleared: {
          ...s.wasExplicitlyCleared,
          [sessionId]: next.length === 0,
        },
      };
    }),
  clearSession: (sessionId) =>
    set((s) => {
      const nextBy = { ...s.bySession };
      delete nextBy[sessionId];
      const nextFlag = { ...s.wasExplicitlyCleared };
      delete nextFlag[sessionId];
      return { bySession: nextBy, wasExplicitlyCleared: nextFlag };
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
  setEngagedAgent: (sessionId, agent) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: agent ? [agent] : [],
      },
      wasExplicitlyCleared: {
        ...s.wasExplicitlyCleared,
        [sessionId]: agent ? false : s.wasExplicitlyCleared[sessionId] ?? false,
      },
    })),
}));
