import { createActorsApi } from "./actor-api";
import {
  initialActorsListState,
  type Actor,
  type ActorsListState,
} from "./actor-types";

type ActorsApi = ReturnType<typeof createActorsApi>;

type Listener = () => void;

export type ActorsController = {
  subscribe: (listener: Listener) => () => void;
  getState: () => ActorsListState;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
};

/** The slice of `TeamCache<Actor>` this controller needs. */
export type ActorsCache = {
  load: (teamId: string) => Promise<Actor[] | null>;
  save: (teamId: string, actors: ReadonlyArray<Actor>) => Promise<void>;
};

export function createActorsController(
  api: Pick<ActorsApi, "listActors">,
  teamId: string,
  cache?: ActorsCache,
): ActorsController {
  let state: ActorsListState = initialActorsListState;
  const listeners = new Set<Listener>();

  function setState(next: ActorsListState) {
    state = next;
    for (const listener of listeners) listener();
  }

  async function fetchActors(mode: "load" | "refresh") {
    if (!teamId) {
      setState({ ...state, status: "ready", actors: [] });
      return;
    }
    setState({
      ...state,
      isLoading: mode === "load",
      isRefreshing: mode === "refresh",
      errorMessage: null,
      status: state.status === "ready" ? state.status : "loading",
    });
    // Paint last-known actors while the fetch is in flight, as iOS does from
    // SwiftData. Cold load only — a refresh already has fresher data on screen.
    if (mode === "load" && cache && state.actors.length === 0) {
      try {
        const cached = await cache.load(teamId);
        if (cached && state.actors.length === 0) {
          setState({ ...state, actors: cached, status: "ready" });
        }
      } catch {
        // A cache miss is not an error worth showing.
      }
    }
    try {
      const actors = await api.listActors(teamId);
      setState({
        status: "ready",
        actors,
        isLoading: false,
        isRefreshing: false,
        errorMessage: null,
      });
      void cache?.save(teamId, actors);
    } catch (error) {
      setState({
        ...state,
        status: state.actors.length > 0 ? "ready" : "error",
        isLoading: false,
        isRefreshing: false,
        errorMessage: error instanceof Error ? error.message : "Couldn't load actors.",
      });
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    load: () => fetchActors("load"),
    refresh: () => fetchActors("refresh"),
  };
}
