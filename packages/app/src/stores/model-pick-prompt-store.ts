import { create } from "zustand";

/**
 * "This agent needs the user to choose a model before anything can run."
 *
 * Set by the send path when `selectAgentModel` comes back `source: "unpicked"`
 * — the catalog listed something, but nobody chose it, so the id on offer is
 * just whatever the provider probe returned first (ADR-0007).
 *
 * A store rather than a prop because the two ends are far apart: the send path
 * discovers the problem inside a callback in `use-chat-send`, and the thing
 * that can fix it is the model popover inside one specific `AgentPill`. Threading
 * a callback down would mean ChatPanel brokering between them for a signal
 * neither of them owns.
 *
 * Deliberately not persisted: it is a request to open a menu, and a menu that
 * springs open on the next launch because of a send three days ago is a bug,
 * not a feature.
 */
interface State {
  /** Agent whose picker should open, or `null` when nothing is pending. */
  pendingAgentId: string | null;
  request: (agentId: string) => void;
  clear: () => void;
}

export const useModelPickPromptStore = create<State>((set) => ({
  pendingAgentId: null,
  request: (agentId) => {
    const id = agentId.trim();
    if (!id) return;
    set({ pendingAgentId: id });
  },
  clear: () => set({ pendingAgentId: null }),
}));
