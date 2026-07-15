import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadDir = vi.fn();
const mockStat = vi.fn();
const mockInvoke = vi.fn();

vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: (...args: unknown[]) => mockReadDir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useWorkspaceStore } from "../workspace";

describe("workspace loadDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue([]);
    useWorkspaceStore.setState({
      workspacePath: "/workspace",
      fileTree: [],
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
    });
  });

  it("treats symlinked directories as directories", async () => {
    mockInvoke.mockResolvedValue([
      {
        name: "linked-dir",
        path: "/workspace/linked-dir",
        type: "directory",
      },
    ]);

    const result = await useWorkspaceStore.getState().loadDirectory(".");

    expect(mockInvoke).toHaveBeenCalledWith("read_workspace_directory", {
      workspacePath: "/workspace",
      path: "/workspace",
    });
    expect(result).toEqual([
      {
        name: "linked-dir",
        path: "/workspace/linked-dir",
        type: "directory",
      },
    ]);
  });

  it("keeps symlinked files as files", async () => {
    mockInvoke.mockResolvedValue([
      {
        name: "linked-file.ts",
        path: "/workspace/linked-file.ts",
        type: "file",
      },
    ]);

    const result = await useWorkspaceStore.getState().loadDirectory(".");

    expect(mockInvoke).toHaveBeenCalledWith("read_workspace_directory", {
      workspacePath: "/workspace",
      path: "/workspace",
    });
    expect(result).toEqual([
      {
        name: "linked-file.ts",
        path: "/workspace/linked-file.ts",
        type: "file",
      },
    ]);
  });

  it("treats directory entries from the workspace reader as directories", async () => {
    mockInvoke.mockResolvedValue([
      {
        name: "skills",
        path: "/workspace/skills",
        type: "directory",
      },
    ]);

    const result = await useWorkspaceStore.getState().loadDirectory(".");

    expect(mockInvoke).toHaveBeenCalledWith("read_workspace_directory", {
      workspacePath: "/workspace",
      path: "/workspace",
    });
    expect(result).toEqual([
      {
        name: "skills",
        path: "/workspace/skills",
        type: "directory",
      },
    ]);
  });

  it("treats file entries from the workspace reader as files", async () => {
    mockInvoke.mockResolvedValue([
      {
        name: "linked-file.md",
        path: "/workspace/linked-file.md",
        type: "file",
      },
    ]);

    const result = await useWorkspaceStore.getState().loadDirectory(".");

    expect(mockInvoke).toHaveBeenCalledWith("read_workspace_directory", {
      workspacePath: "/workspace",
      path: "/workspace",
    });
    expect(result).toEqual([
      {
        name: "linked-file.md",
        path: "/workspace/linked-file.md",
        type: "file",
      },
    ]);
  });

  it("lists a symlink directory through the workspace reader when fs scope would reject the target", async () => {
    mockInvoke.mockResolvedValue([
      {
        name: "README.md",
        path: "/workspace/ac360-link/README.md",
        type: "file",
      },
    ]);

    const result = await useWorkspaceStore.getState().loadDirectory("/workspace/ac360-link");

    expect(mockReadDir).not.toHaveBeenCalled();
    expect(mockStat).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("read_workspace_directory", {
      workspacePath: "/workspace",
      path: "/workspace/ac360-link",
    });
    expect(result).toEqual([
      {
        name: "README.md",
        path: "/workspace/ac360-link/README.md",
        type: "file",
      },
    ]);
  });
});
