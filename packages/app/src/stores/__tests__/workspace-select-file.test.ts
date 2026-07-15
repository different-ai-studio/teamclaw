import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadTextFile, mockInvoke } = vi.hoisted(() => ({
  mockReadTextFile: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  isTauri: () => true,
}));

vi.mock("@/components/viewers/UnsupportedFileViewer", () => ({
  UNSUPPORTED_BINARY_EXTENSIONS: new Set<string>(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
  readFile: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useWorkspaceStore } from "../workspace";

describe("workspace selectFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      workspacePath: "/workspace",
      selectedFile: null,
      selectedFiles: [],
      lastSelectedFile: null,
      isLoadingFile: false,
      fileContent: null,
      targetLine: null,
      targetHeading: null,
    });
  });

  it("loads text content through backend workspace reader when fs scope rejects a symlink target", async () => {
    mockReadTextFile.mockRejectedValue(
      new Error(
        "forbidden path: /Users/weigan.huang/ws/ac360-team, maybe it is not allowed on the scope for `allow-read-text-file` permission in your capability file",
      ),
    );
    mockInvoke.mockResolvedValue("linked file content");

    await useWorkspaceStore.getState().selectFile("/workspace/ac360-link/README.md");

    expect(mockInvoke).toHaveBeenCalledWith("read_workspace_text_file", {
      workspacePath: "/workspace",
      path: "/workspace/ac360-link/README.md",
    });
    expect(useWorkspaceStore.getState().fileContent).toBe("linked file content");
    expect(useWorkspaceStore.getState().isLoadingFile).toBe(false);
  });

  it("does not read a directory path as a text file", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "read_workspace_directory") return Promise.resolve([]);
      return Promise.resolve("should not read");
    });
    useWorkspaceStore.setState({
      fileTree: [
        {
          name: "teamclaw-team",
          path: "/workspace/teamclaw-team",
          type: "directory",
        },
      ],
    });

    await useWorkspaceStore.getState().selectFile("/workspace/teamclaw-team");

    expect(mockInvoke).not.toHaveBeenCalledWith("read_workspace_text_file", expect.anything());
    expect(useWorkspaceStore.getState().selectedFile).toBeNull();
    expect(useWorkspaceStore.getState().fileContent).toBeNull();
    expect(useWorkspaceStore.getState().isLoadingFile).toBe(false);
    expect(useWorkspaceStore.getState().expandedPaths.has("/workspace/teamclaw-team")).toBe(true);
  });
});
