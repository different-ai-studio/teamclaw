import { createIdeasApi } from "./idea-api";
import {
  compareIdeas,
  initialIdeasListState,
  sortOrderForIndex,
  type Idea,
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

/** The slice of `TeamCache<CachedIdea>` this controller needs. */
export type IdeasCache = {
  load: (teamId: string) => Promise<Idea[] | null>;
  save: (teamId: string, ideas: ReadonlyArray<Idea>) => Promise<void>;
};

export function createIdeasController(
  api: Pick<IdeasApi, "listIdeas">,
  teamId: string,
  cache?: IdeasCache,
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
    // Paint last-known ideas while the fetch is in flight, the way iOS reads
    // SwiftData before its refresh lands. Only on a cold load: during a
    // pull-to-refresh the list on screen is already newer than the cache.
    if (mode === "load" && cache && state.ideas.length === 0) {
      try {
        const cached = await cache.load(teamId);
        if (cached && state.ideas.length === 0) {
          setState({ ...state, ideas: [...cached].sort(compareIdeas), status: "ready" });
        }
      } catch {
        // A cache miss is not an error worth showing.
      }
    }
    try {
      const ideas = await api.listIdeas(teamId);
      setState({
        status: "ready",
        ideas,
        isLoading: false,
        isRefreshing: false,
        errorMessage: null,
      });
      void cache?.save(teamId, ideas);
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
