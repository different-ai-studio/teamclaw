import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadDir = vi.fn();
const mockStat = vi.fn();

vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: (...args: unknown[]) => mockReadDir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}));

import { useWorkspaceStore } from "../workspace";

describe("workspace loadDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      workspacePath: "/workspace",
      fileTree: [],
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
    });
  });

  it("treats symlinked directories as directories", async () => {
    mockReadDir.mockResolvedValue([
      {
        name: "linked-dir",
        isDirectory: false,
        isFile: false,
        isSymlink: true,
      },
    ]);
    mockStat.mockResolvedValue({
      isDirectory: true,
      isFile: false,
      isSymlink: false,
    });

    const result = await useWorkspaceStore.getState().loadDirectory(".");

    expect(mockStat).toHaveBeenCalledWith("/workspace/linked-dir");
    expect(result).toEqual([
      {
        name: "linked-dir",
        path: "/workspace/linked-dir",
        type: "directory",
      },
    ]);
  });

  it("keeps symlinked files as files", async () => {
    mockReadDir.mockResolvedValue([
      {
        name: "linked-file.ts",
        isDirectory: false,
        isFile: false,
        isSymlink: true,
      },
    ]);
    mockStat.mockResolvedValue({
      isDirectory: false,
      isFile: true,
      isSymlink: false,
    });

    const result = await useWorkspaceStore.getState().loadDirectory(".");

    expect(mockStat).toHaveBeenCalledWith("/workspace/linked-file.ts");
    expect(result).toEqual([
      {
        name: "linked-file.ts",
        path: "/workspace/linked-file.ts",
        type: "file",
      },
    ]);
  });

  it("treats alias-like ambiguous entries as directories via stat fallback", async () => {
    mockReadDir.mockResolvedValue([
      {
        name: "skills",
        isDirectory: false,
        isFile: false,
        isSymlink: false,
      },
    ]);
    mockStat.mockResolvedValue({
      isDirectory: true,
      isFile: false,
      isSymlink: false,
    });

    const result = await useWorkspaceStore.getState().loadDirectory(".");

    expect(mockStat).toHaveBeenCalledWith("/workspace/skills");
    expect(result).toEqual([
      {
        name: "skills",
        path: "/workspace/skills",
        type: "directory",
      },
    ]);
  });

  it("treats ambiguous linked files as files via stat fallback", async () => {
    mockReadDir.mockResolvedValue([
      {
        name: "linked-file.md",
        isDirectory: false,
        isFile: false,
        isSymlink: false,
      },
    ]);
    mockStat.mockResolvedValue({
      isDirectory: false,
      isFile: true,
      isSymlink: false,
    });

    const result = await useWorkspaceStore.getState().loadDirectory(".");

    expect(mockStat).toHaveBeenCalledWith("/workspace/linked-file.md");
    expect(result).toEqual([
      {
        name: "linked-file.md",
        path: "/workspace/linked-file.md",
        type: "file",
      },
    ]);
  });
});
