import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Last known `agents.default_workspace_id` per agent, cached on this client.
 *
 * # Why
 *
 * `runtimeStart.workspaceId` is resolved through a chain that ends at the actor
 * directory, which loads asynchronously. On a **new session's first send** the
 * two earlier links are structurally empty — there is no prior runtime for a
 * session that did not exist a second ago — so if the directory has not landed
 * yet the whole chain yields `''`.
 *
 * An empty `workspaceId` is not harmless. The daemon skips its workspace
 * resolver entirely for it (`runtime_lifecycle.rs`: the resolver only runs when
 * `!workspace_id.is_empty()`) and starts in whatever worktree the client passed.
 * Measured on this machine: the first start went to `~/TeamClu`, and 6.6s later
 * the resolved id arrived pointing at `~/TeamClu Dev`, which superseded the
 * runtime and respawned the backend — `pi env changed; respawning`. The 5.5s
 * cold start was paid twice, which is what makes a first message feel slow.
 *
 * # The ordering rule
 *
 * **The live value always wins.** This is server-owned config, not a client
 * preference: someone can change the default workspace in Daemon settings or on
 * another device. The cache is consulted only when the live chain has nothing,
 * and is overwritten whenever the live chain produces an answer. Letting it
 * outrank the live value would trade a slow start for a start in the wrong
 * directory — a worse failure, and a silent one.
 *
 * # What it does not fix
 *
 * The very first run on a fresh install still has a cold cache and still takes
 * the slow path. This removes the repeat, not the first occurrence.
 */

interface State {
  /** agent actor id → last known cloud workspace UUID. */
  byAgentId: Record<string, string>;
  remember: (agentActorId: string, workspaceId: string) => void;
  recall: (agentActorId: string) => string;
  clear: () => void;
}

export const useAgentDefaultWorkspaceStore = create<State>()(
  persist(
    (set, get) => ({
      byAgentId: {},
      remember: (agentActorId, workspaceId) => {
        const agent = agentActorId.trim();
        const ws = workspaceId.trim();
        if (!agent || !ws) return;
        set((s) =>
          s.byAgentId[agent] === ws
            ? s
            : { byAgentId: { ...s.byAgentId, [agent]: ws } },
        );
      },
      recall: (agentActorId) => get().byAgentId[agentActorId.trim()] ?? "",
      clear: () => set({ byAgentId: {} }),
    }),
    {
      name: "teamclu.agent-default-workspace.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ byAgentId: s.byAgentId }),
    },
  ),
);

/**
 * Cached default for the first of `agentActorIds` that has one, or `''`.
 *
 * Never throws: this sits on the send path, and a missing cache entry must read
 * as "no cached answer" rather than break the send it is meant to speed up.
 */
export function cachedDefaultWorkspaceId(
  agentActorIds: readonly string[],
): string {
  try {
    const store = useAgentDefaultWorkspaceStore.getState();
    for (const id of agentActorIds) {
      const hit = store.recall(id ?? "");
      if (hit) return hit;
    }
  } catch {
    /* fall through */
  }
  return "";
}

/** Record a live-resolved workspace id for every agent it applies to. */
export function rememberDefaultWorkspaceId(
  agentActorIds: readonly string[],
  workspaceId: string,
): void {
  const ws = workspaceId.trim();
  if (!ws) return;
  try {
    const { remember } = useAgentDefaultWorkspaceStore.getState();
    for (const id of agentActorIds) remember(id ?? "", ws);
  } catch {
    /* a cache write must never break a send */
  }
}
