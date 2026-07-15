// @vitest-environment jsdom

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockFileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: MockFileNode[];
};

let mockFileTree: MockFileNode[] = [];
let latestNodesProp: MockFileNode[] | undefined;

const mockExpandDirectory = vi.fn(async (path: string) => {
  if (path === "/workspace/teamclaw-team") {
    mockFileTree = mockFileTree.map((node) =>
      node.path === path
        ? {
            ...node,
            children: [
              {
                name: "knowledge",
                path: "/workspace/teamclaw-team/knowledge",
                type: "directory",
              },
            ],
          }
        : node,
    );
  }

  if (path === "/workspace/teamclaw-team/knowledge") {
    mockFileTree = mockFileTree.map((node) =>
      node.path === "/workspace/teamclaw-team"
        ? {
            ...node,
            children: node.children?.map((child) =>
              child.path === path
                ? {
                    ...child,
                    children: [
                      {
                        name: "guide.md",
                        path: "/workspace/teamclaw-team/knowledge/guide.md",
                        type: "file",
                      },
                    ],
                  }
                : child,
            ),
          }
        : node,
    );
  }
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: Array<string | false | null | undefined>) =>
    args.filter(Boolean).join(" "),
  isTauri: () => false,
}));

vi.mock("@/hooks/useFileChangeListener", () => ({
  useFileChangeListener: vi.fn(),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollBar: () => null,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../FileTree", () => ({
  FileTree: ({ nodes }: { nodes?: MockFileNode[] }) => {
    latestNodesProp = nodes;
    return <div data-testid="file-tree" />;
  },
}));

vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        workspacePath: "/workspace",
        isPanelOpen: true,
        fileTree: mockFileTree,
        refreshFileTree: vi.fn().mockResolvedValue(undefined),
        collapseAll: vi.fn(),
        undo: vi.fn().mockResolvedValue(true),
        undoStack: [],
        expandDirectory: mockExpandDirectory,
      }),
    {
      getState: () => ({
        workspacePath: "/workspace",
        expandDirectory: mockExpandDirectory,
      }),
      subscribe: vi.fn(() => vi.fn()),
      setState: vi.fn(),
    },
  ),
}));

import { FileBrowser } from "../FileBrowser";

describe("FileBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileTree = [];
    latestNodesProp = undefined;
  });

  it("retries loading custom root ancestors after the global tree becomes available", async () => {
    const rootPath = "/workspace/teamclaw-team/knowledge";
    const rootPaths = [rootPath];
    const { rerender } = render(
      <FileBrowser variant="panel" rootPaths={rootPaths} />,
    );

    await waitFor(() => {
      expect(mockExpandDirectory).toHaveBeenCalledWith("/workspace/teamclaw-team");
      expect(mockExpandDirectory).toHaveBeenCalledWith(rootPath);
    });

    await act(async () => {
      mockFileTree = [
        {
          name: "teamclaw-team",
          path: "/workspace/teamclaw-team",
          type: "directory",
        },
      ];
      rerender(<FileBrowser variant="panel" rootPaths={rootPaths} />);
    });

    await waitFor(() => {
      expect(mockExpandDirectory).toHaveBeenCalledTimes(4);
    });

    await act(async () => {
      rerender(<FileBrowser variant="panel" rootPaths={rootPaths} />);
    });

    expect(latestNodesProp?.[0]?.children).toEqual([
      {
        name: "guide.md",
        path: "/workspace/teamclaw-team/knowledge/guide.md",
        type: "file",
      },
    ]);
  });
});
