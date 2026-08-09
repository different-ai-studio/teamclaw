import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();

vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useWorkspaceStore } from "../workspace";

type Node = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: Node[];
};

const TEAM = "/workspace/teamclu-team";
const KNOWLEDGE = `${TEAM}/knowledge`;

/** A directory listing as the backend returns it: no children on any entry. */
const listing = (...nodes: Array<[string, string, "file" | "directory"]>): Node[] =>
  nodes.map(([name, path, type]) => ({ name, path, type }));

const childrenOf = (nodes: Node[], target: string): Node[] | undefined => {
  for (const node of nodes) {
    if (node.path === target) return node.children;
    if (node.children) {
      const found = childrenOf(node.children, target);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

describe("workspace expandDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      workspacePath: "/workspace",
      fileTree: listing(["teamclu-team", TEAM, "directory"]),
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
    });
  });

  /**
   * The regression behind the Knowledge column spinning at ~33 IPC calls/sec:
   * re-listing a parent used to replace its children wholesale, and a fresh
   * listing carries no grandchildren — so every parent refresh silently
   * un-loaded the subtree below it, and callers that read "children ===
   * undefined" as "needs loading" immediately asked for it again.
   */
  it("keeps an already-loaded child subtree when the parent is re-listed", async () => {
    const store = useWorkspaceStore.getState();

    mockInvoke.mockResolvedValueOnce(listing(["knowledge", KNOWLEDGE, "directory"]));
    await store.expandDirectory(TEAM);

    mockInvoke.mockResolvedValueOnce(listing(["guide.md", `${KNOWLEDGE}/guide.md`, "file"]));
    await store.expandDirectory(KNOWLEDGE);

    expect(childrenOf(useWorkspaceStore.getState().fileTree, KNOWLEDGE)).toHaveLength(1);

    // Same listing again — the shape the backend always returns.
    mockInvoke.mockResolvedValueOnce(listing(["knowledge", KNOWLEDGE, "directory"]));
    await store.expandDirectory(TEAM);

    expect(childrenOf(useWorkspaceStore.getState().fileTree, KNOWLEDGE)).toEqual([
      { name: "guide.md", path: `${KNOWLEDGE}/guide.md`, type: "file" },
    ]);
  });

  it("drops the old subtree when a path changes from directory to file", async () => {
    const store = useWorkspaceStore.getState();

    mockInvoke.mockResolvedValueOnce(listing(["knowledge", KNOWLEDGE, "directory"]));
    await store.expandDirectory(TEAM);
    mockInvoke.mockResolvedValueOnce(listing(["guide.md", `${KNOWLEDGE}/guide.md`, "file"]));
    await store.expandDirectory(KNOWLEDGE);

    mockInvoke.mockResolvedValueOnce(listing(["knowledge", KNOWLEDGE, "file"]));
    await store.expandDirectory(TEAM);

    expect(childrenOf(useWorkspaceStore.getState().fileTree, KNOWLEDGE)).toBeUndefined();
  });

  it("forgets children the listing no longer reports", async () => {
    const store = useWorkspaceStore.getState();

    mockInvoke.mockResolvedValueOnce(listing(["knowledge", KNOWLEDGE, "directory"]));
    await store.expandDirectory(TEAM);
    mockInvoke.mockResolvedValueOnce(listing(["guide.md", `${KNOWLEDGE}/guide.md`, "file"]));
    await store.expandDirectory(KNOWLEDGE);

    mockInvoke.mockResolvedValueOnce(listing(["other", `${TEAM}/other`, "directory"]));
    await store.expandDirectory(TEAM);

    const teamChildren = childrenOf(useWorkspaceStore.getState().fileTree, TEAM);
    expect(teamChildren?.map((n) => n.path)).toEqual([`${TEAM}/other`]);
  });

  /**
   * Two loads of the same path must not overlap: the one that started first
   * could otherwise publish last, republishing children it read before the
   * other call's write.
   */
  it("serialises concurrent expands of the same path", async () => {
    const store = useWorkspaceStore.getState();
    let inFlight = 0;
    let maxInFlight = 0;

    mockInvoke.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return listing(["second", `${TEAM}/second`, "directory"]);
    });

    await Promise.all([store.expandDirectory(TEAM), store.expandDirectory(TEAM)]);

    expect(maxInFlight).toBe(1);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(useWorkspaceStore.getState().loadingPaths.has(TEAM)).toBe(false);
  });

  it("does not let a failed expand block later expands of the same path", async () => {
    const store = useWorkspaceStore.getState();

    // loadDirectory swallows backend errors, so drive the failure through the
    // store's own contract rather than faking a rejection it never surfaces.
    mockInvoke.mockRejectedValueOnce(new Error("boom"));
    await store.expandDirectory(TEAM);

    mockInvoke.mockResolvedValueOnce(listing(["knowledge", KNOWLEDGE, "directory"]));
    await store.expandDirectory(TEAM);

    expect(childrenOf(useWorkspaceStore.getState().fileTree, TEAM)?.map((n) => n.path)).toEqual([
      KNOWLEDGE,
    ]);
  });
});
