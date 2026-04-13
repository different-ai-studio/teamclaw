import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ToolCall } from "@/stores/session";

vi.mock("@/stores/session", () => ({
  useSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        forceCompleteToolCall: vi.fn(),
        replyPermission: vi.fn(() => Promise.resolve()),
      }),
    {
      getState: () => ({
        setViewingChildSession: vi.fn(),
      }),
    },
  ),
  convertMessage: vi.fn(),
}));

vi.mock("@/stores/streaming", () => ({
  useStreamingStore: (selector: (state: unknown) => unknown) =>
    selector({
      childSessionStreaming: {
        "child-session-1": {
          sessionId: "child-session-1",
          text: "streaming details should stay in the child session view",
          reasoning: "",
          isStreaming: true,
        },
      },
    }),
}));

vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        workspacePath: "/workspace",
        selectFile: vi.fn(),
      }),
    {
      getState: () => ({
        workspacePath: "/workspace",
        selectFile: vi.fn(),
      }),
    },
  ),
}));

vi.mock("@/lib/opencode/sdk-client", () => ({
  getOpenCodeClient: vi.fn(),
}));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return {
    ...actual,
    openExternalUrl: vi.fn(),
  };
});

import { SkillToolCard, TaskToolCard } from "@/components/chat/tool-calls/TaskToolCard";

describe("TaskToolCard", () => {
  it("keeps only the view-session entry in the parent session", () => {
    const toolCall: ToolCall = {
      id: "task-1",
      name: "task",
      status: "calling",
      arguments: {
        description: "Investigate the regression",
        subagent_type: "worker",
      },
      result: "<task_result>final child output should not be shown inline</task_result>\nsession_id: child-session-1",
      startTime: new Date("2026-04-10T10:00:00Z"),
      duration: 1200,
      metadata: {
        sessionId: "child-session-1",
        summary: [
          {
            id: "summary-1",
            tool: "read",
            state: {
              status: "running",
              title: "src/app.tsx",
            },
          },
        ],
      },
    };

    render(<TaskToolCard toolCall={toolCall} />);

    expect(screen.getByText("查看会话")).toBeTruthy();
    expect(screen.queryByText("查看子任务详情")).toBeNull();
    expect(screen.queryByText("final child output should not be shown inline")).toBeNull();
    expect(screen.queryByText("streaming details should stay in the child session view")).toBeNull();
  });

  it("renders permission approval actions for pending skill tool calls", () => {
    const toolCall: ToolCall = {
      id: "skill-1",
      name: "skill",
      status: "waiting",
      arguments: {
        name: "dispatching-parallel-agents",
      },
      startTime: new Date("2026-04-10T10:00:00Z"),
      permission: {
        id: "perm-skill-1",
        permission: "skill",
        patterns: ["dispatching-parallel-agents"],
        decision: "pending",
      },
    };

    render(<SkillToolCard toolCall={toolCall} />);

    expect(screen.getByText("Skill dispatching-parallel-agents")).toBeTruthy();
    expect(screen.getByText("Deny")).toBeTruthy();
    expect(screen.getByText("Always allow 'dispatching-parallel-agents'")).toBeTruthy();
    expect(screen.getByText("Allow")).toBeTruthy();
  });
});
