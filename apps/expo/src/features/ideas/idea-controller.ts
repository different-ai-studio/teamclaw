import { createIdeasApi } from "./idea-api";
import {
  compareIdeas,
  initialIdeasListState,
  sortOrderForIndex,
  type IdeasListState,
} from "./idea-types";

type IdeasApi = ReturnType<typeof createIdeasApi>;

export type IdeasController = {
  subscribe: (listener: () => void) => () => void;
  getState: () => IdeasListState;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * Renumber `sortOrder` from the given id order and re-sort, so a reorder
   * shows up before the round-trip lands. Mirrors the optimistic half of iOS
   * `IdeaStore.moveIdeas`; the caller reverts by refreshing on failure.
   */
  applyReorder: (orderedIds: ReadonlyArray<string>) => void;
};

export function createIdeasController(
  api: Pick<IdeasApi, "listIdeas">,
  teamId: string,
): IdeasController {
  let state: IdeasListState = initialIdeasListState;
  const listeners = new Set<() => void>();

  function setState(next: IdeasListState) {
    state = next;
    for (const listener of listeners) listener();
  }

  async function fetch(mode: "load" | "refresh") {
    if (!teamId) {
      setState({ ...state, status: "ready", ideas: [] });
      return;
    }
    setState({
      ...state,
      isLoading: mode === "load",
      isRefreshing: mode === "refresh",
      errorMessage: null,
      status: state.status === "ready" ? state.status : "loading",
    });
    try {
      const ideas = await api.listIdeas(teamId);
      setState({
        status: "ready",
        ideas,
        isLoading: false,
        isRefreshing: false,
        errorMessage: null,
      });
    } catch (error) {
      setState({
        ...state,
        status: state.ideas.length > 0 ? "ready" : "error",
        isLoading: false,
        isRefreshing: false,
        errorMessage: error instanceof Error ? error.message : "Couldn't load ideas.",
      });
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    load: () => fetch("load"),
    refresh: () => fetch("refresh"),
    applyReorder(orderedIds) {
      const position = new Map(orderedIds.map((id, index) => [id, index]));
      const ideas = state.ideas
        .map((idea) => {
          const index = position.get(idea.ideaId);
          return index === undefined ? idea : { ...idea, sortOrder: sortOrderForIndex(index) };
        })
        .sort(compareIdeas);
      setState({ ...state, ideas });
    },
  };
}
