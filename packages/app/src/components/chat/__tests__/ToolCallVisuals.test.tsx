import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ToolCall } from "@/stores/session";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallbackOrOptions?: string | { defaultValue?: string; [key: string]: unknown },
      maybeOptions?: Record<string, unknown>,
    ) => {
      const template =
        typeof fallbackOrOptions === "string"
          ? fallbackOrOptions
          : fallbackOrOptions?.defaultValue ?? key;
      const options =
        typeof fallbackOrOptions === "string"
          ? maybeOptions
          : { ...fallbackOrOptions, ...maybeOptions };
      return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) =>
        String(options?.[token] ?? `{{${token}}}`),
      );
    },
  }),
}));

const setViewingChildSession = vi.fn();

vi.mock("@/stores/session", () => ({
  useSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({}),
    {
      getState: () => ({
        setViewingChildSession,
      }),
    },
  ),
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

vi.mock("@/hooks/useToolCallFileOnDisk", () => ({
  resolveWorkspaceRelativePath: (path: string | null) => path,
  useToolCallFileOnDisk: () => true,
}));

vi.mock("@/lib/opencode/sdk-client", () => ({
  getOpenCodeClient: vi.fn(),
}));

import { ToolCallCard } from "@/components/chat/ToolCallCard";
import { ReadToolCard } from "@/components/chat/tool-calls/ReadToolCard";
import { RoleLoadToolCard } from "@/components/chat/tool-calls/RoleLoadToolCard";
import { EditToolCard } from "@/components/chat/tool-calls/EditToolCard";
import { RoleSkillToolCard, SkillToolCard, TaskToolCard } from "@/components/chat/tool-calls/TaskToolCard";
import { WriteToolCard } from "@/components/chat/tool-calls/WriteToolCard";

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: "tool-1",
    name: "grep",
    status: "completed",
    arguments: {},
    startTime: new Date("2026-04-21T00:00:00Z"),
    ...overrides,
  };
}

function expectBreathingStatusLight() {
  const status = screen.getByTestId("tool-call-breathing-status");
  expect(status.textContent).not.toContain("●");
  expect(status.querySelector(".animate-ping")).toBeTruthy();
}

describe("Tool call visual redesign", () => {
  it("renders grep as a compact event row instead of a heavy collapsible card", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "grep",
      arguments: { pattern: "processor" },
      result: "6 hits in 3 files",
    })} />);

    const row = screen.getByTestId("tool-row-grep");
    expect(row.className).toContain("grid");
    expect(row.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(row.className).toContain("py-[4px]");
    expect(screen.getByText("Grep")).toBeTruthy();
    expect(screen.getByText("processor")).toBeTruthy();
    expect(screen.queryByText(/6 hits in 3 files/)).toBeNull();
    expect(screen.queryByText(/found/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /grep/i })).toBeNull();
  });

  it("renders glob as a non-interactive compact row", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "glob",
      arguments: { pattern: "*parser*.go" },
      result: "14 matches",
    })} />);

    const row = screen.getByTestId("tool-row-glob");
    expect(row.className).toContain("grid");
    expect(row.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(row.className).toContain("py-[4px]");
    expect(screen.getByText("Glob")).toBeTruthy();
    expect(screen.getByText("*parser*.go")).toBeTruthy();
    expect(screen.queryByText(/14 matches/)).toBeNull();
    expect(screen.queryByText(/no files found/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /glob/i })).toBeNull();
  });

  it("renders prompt-like bash output as a normal running command card", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "bash",
      status: "calling",
      arguments: { command: "gws sheets values" },
      result: "Continue? [y/N]",
    })} />);

    const row = screen.getByTestId("tool-card-bash");
    expect(row.className).toContain("rounded-[14px]");
    expect(row.className).not.toContain("shadow");
    expect(screen.getByText("Execute command")).toBeTruthy();
    expect(screen.getByText("gws sheets values")).toBeTruthy();
    expect(screen.queryByText("Waiting for input")).toBeNull();
    expect(screen.queryByText("This command is waiting for confirmation or stdin.")).toBeNull();
  });

  it("renders a running bash command status as a breathing light", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "bash",
      status: "calling",
      arguments: { command: "pnpm test" },
    })} />);

    expectBreathingStatusLight();
  });

  it("renders bash output in a collapsible area with max height", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "bash",
      status: "completed",
      arguments: { command: "cat long.log" },
      result: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7",
    })} />);

    expect(screen.queryByText("line 7")).toBeNull();
    expect(screen.queryByText("已完成")).toBeNull();

    const header = screen.getByRole("button", { name: /Execute command cat long\.log/ });
    fireEvent.click(header);

    const output = screen.getByTestId("tool-card-bash-output");
    expect(output.textContent).toContain("line 7");
    expect(output.textContent).toContain("$");
    expect(output.textContent).toContain("cat long.log");
    expect(output.className).toContain("max-h-[280px]");
    expect(output.className).toContain("overflow-auto");
  });

  it("allows toggling bash output even when the command has no textual output", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      id: "tool-empty-bash",
      name: "bash",
      status: "completed",
      arguments: { command: "lsof -nP -iTCP:8081 -sTCP:LISTEN" },
      result: "",
    })} />);

    const header = screen.getByRole("button", { name: /Execute command lsof -nP -iTCP:8081 -sTCP:LISTEN/ });
    fireEvent.click(header);

    const output = screen.getByTestId("tool-card-bash-output");
    expect(output.textContent).toContain("No output");
  });

  it("shows the full bash command in the expanded terminal-style body", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      id: "tool-long-bash",
      name: "bash",
      status: "completed",
      arguments: {
        command:
          '/Users/haigang.ye/project/accounting-live/scripts/query_logs.sh --application billing-core --trace-id 7d9e7db1-62f8-4b6b-9c38-0d64f542c104 --query-string "service:billing level:error" --hours 24 --limit 20 --output-path /Users/haigang.ye/project/accounting-live/tmp/query_logs_usage.txt',
      },
      result: "Usage:\nquery_logs.sh --application <app|suffix>",
    })} />);

    fireEvent.click(screen.getByRole("button", { name: /Execute command/ }));

    const output = screen.getByTestId("tool-card-bash-output");
    expect(output.textContent).toContain("/Users/haigang.ye/project/accounting-live/scripts/query_logs.sh");
    expect(output.textContent).toContain("--query-string");
    expect(output.textContent).toContain("Usage:");
  });

  it("prefers an explicit command description before the command text", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      id: "tool-desc-bash",
      name: "bash",
      status: "completed",
      arguments: {
        command: "cp ./dist/app ./bin/app",
        description: "复制构建产物",
      },
      result: "copied",
    })} />);

    expect(screen.getByText("复制构建产物")).toBeTruthy();
    expect(screen.getByText("cp ./dist/app ./bin/app")).toBeTruthy();
  });

  it("renders read as a compact event row", () => {
    render(<ReadToolCard toolCall={makeToolCall({
      name: "read",
      arguments: { path: "docs/ROLE.md" },
      result: "123456789012",
    })} />);

    const row = screen.getByTestId("tool-row-read");
    expect(row.className).toContain("grid");
    expect(row.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(row.className).toContain("py-[4px]");
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("ROLE.md")).toBeTruthy();
    expect(screen.getByText("· 12 B")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /read/i })).toBeNull();
  });

  it("renders skill as a light summary card with description chips", () => {
    render(<SkillToolCard toolCall={makeToolCall({
      name: "skill",
      arguments: { name: "using-superpowers" },
      result: '<skill_content name="using-superpowers">\n# Skill: using-superpowers',
    })} />);

    const card = screen.getByTestId("tool-card-skill");
    expect(card.className).toContain("rounded-[14px]");
    expect(screen.getByText("Skill")).toBeTruthy();
    expect(screen.getByText("using-superpowers")).toBeTruthy();
    expect(screen.queryByText(/skill_content/)).toBeNull();
    expect(screen.queryByText(/# Skill:/)).toBeNull();
  });

  it("renders role load as a two-section summary card", () => {
    render(<RoleLoadToolCard toolCall={makeToolCall({
      name: "role_load",
      arguments: {
        name: "recon-file-parse-config-operator",
      },
      result: "Description: reconciliation-oriented parse config for shopee_payment_channel_file_transfer\n## Role Skills\n1. alpha\n2. beta",
    })} />);

    const card = screen.getByTestId("tool-card-role-load");
    expect(card.className).toContain("rounded-[14px]");
    expect(card.className).toContain("bg-[#fbfcfe]");
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("role instructions + 2 role skills")).toBeTruthy();
    expect(screen.getByText("Context")).toBeTruthy();
    expect(screen.getByText("recon-file-parse-config-operator")).toBeTruthy();
  });

  it("renders write as a strong diff card", () => {
    render(<WriteToolCard toolCall={makeToolCall({
      name: "write",
      arguments: {
        path: "preview_parse_result_test.go",
        content: "package main\n\nfunc test() {}\nconst a = 1\nconst b = 2\n",
      },
      result: "package main\n\nfunc test() {}\nconst a = 1\nconst b = 2\n",
    })} />);

    const card = screen.getByTestId("tool-card-write");
    expect(card.className).toContain("rounded-[14px]");
    expect(card.className).toContain("bg-[#fbfcfe]");
    expect(screen.getByText(/\+ package main/)).toBeTruthy();
    expect(screen.getByText(/\+ const b = 2/)).toBeTruthy();
    expect(screen.getByText("✓")).toBeTruthy();
  });

  it("renders edit as a strong diff card", () => {
    render(<EditToolCard toolCall={makeToolCall({
      name: "edit",
      arguments: {
        path: "preview_parse_result_test.go",
        old_string: "old line",
        new_string: "new line",
      },
    })} />);

    const card = screen.getByTestId("tool-card-edit");
    expect(card.className).toContain("rounded-[14px]");
    expect(card.className).toContain("bg-[#fbfcfe]");
  });

  it("renders subagent as a clickable card instead of an inline text row", () => {
    render(<TaskToolCard toolCall={makeToolCall({
      name: "task",
      status: "completed",
      arguments: {
        description: "Inspect parser config boundaries",
        subagent_type: "explorer",
      },
      metadata: {
        sessionId: "child-1",
        summary: [
          { id: "s1", tool: "read", state: { status: "completed" } },
          { id: "s2", tool: "grep", state: { status: "completed" } },
          { id: "s3", tool: "bash", state: { status: "waiting" } },
        ],
      },
    })} />);

    const card = screen.getByTestId("tool-card-task");
    expect(card.className).toContain("rounded-[14px]");
    expect(card.className).toContain("bg-[#fbfcfe]");
    expect(screen.getByText(/View session/)).toBeTruthy();
    expect(screen.getByText("Opens child conversation · 3 updates")).toBeTruthy();
    expect(screen.getByText("✓")).toBeTruthy();
  });

  it("renders todowrite as a compact todo event row", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "todowrite",
      arguments: {},
      result: "3 items updated · 1 in progress",
    })} />);

    const row = screen.getByTestId("tool-row-todowrite");
    expect(row.className).toContain("grid");
    expect(row.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(row.className).toContain("py-[4px]");
    expect(screen.getByText("Todo")).toBeTruthy();
    expect(screen.getByText("3 items updated")).toBeTruthy();
    expect(screen.getByText(/1 in progress/)).toBeTruthy();
  });

  it("renders todo JSON payload as a compact summary instead of raw content", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "todowrite",
      arguments: {},
      result: JSON.stringify([
        { content: "Explore project context", status: "completed", priority: "high" },
        { content: "Present design", status: "in_progress", priority: "high" },
        { content: "Write design doc", status: "pending", priority: "medium" },
      ]),
    })} />);

    const row = screen.getByTestId("tool-row-todowrite");
    expect(row.className).toContain("grid");
    expect(row.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(row.className).toContain("py-[4px]");
    expect(screen.getByText("Todo")).toBeTruthy();
    expect(screen.getByText("3 items updated")).toBeTruthy();
    expect(screen.getByText(/1 in progress/)).toBeTruthy();
    expect(screen.queryByText(/Explore project context/)).toBeNull();
  });

  it("renders role skill as a single event row", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "role_skill",
      arguments: { name: "recon-parse-config-authoring" },
    })} />);

    const row = screen.getByTestId("tool-row-role-skill");
    expect(row.className).toContain("grid");
    expect(row.className).toContain("py-[6px]");
    expect(screen.getByText("Role skill")).toBeTruthy();
    expect(screen.getByText("recon-parse-config-authoring")).toBeTruthy();
  });

  it("renders running specialized tool statuses as breathing lights", () => {
    const { rerender } = render(<SkillToolCard toolCall={makeToolCall({
      name: "skill",
      status: "calling",
      arguments: { name: "using-superpowers" },
    })} />);
    expectBreathingStatusLight();

    rerender(<RoleSkillToolCard toolCall={makeToolCall({
      name: "role_skill",
      status: "calling",
      arguments: { name: "recon-parse-config-authoring" },
    })} />);
    expectBreathingStatusLight();

    rerender(<RoleLoadToolCard toolCall={makeToolCall({
      name: "role_load",
      status: "calling",
      arguments: { name: "recon-file-parse-config-operator" },
    })} />);
    expectBreathingStatusLight();

    rerender(<WriteToolCard toolCall={makeToolCall({
      name: "write",
      status: "calling",
      arguments: { path: "preview_parse_result_test.go" },
    })} />);
    expectBreathingStatusLight();

    rerender(<EditToolCard toolCall={makeToolCall({
      name: "edit",
      status: "calling",
      arguments: {
        path: "preview_parse_result_test.go",
        old_string: "old line",
        new_string: "new line",
      },
    })} />);
    expectBreathingStatusLight();

    rerender(<TaskToolCard toolCall={makeToolCall({
      name: "task",
      status: "calling",
      arguments: {
        description: "Inspect parser config boundaries",
        subagent_type: "explorer",
      },
    })} />);
    expectBreathingStatusLight();
  });

  it("renders unknown tools with a compact expandable fallback card", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "team_create",
      status: "completed",
      arguments: {
        name: "review-team",
        roles: ["planner", "reviewer"],
      },
      result: {
        ok: true,
        team_id: "team-1",
      },
    })} />);

    const header = screen.getByRole("button", { name: /Team create/ });
    expect(header.className).toContain("px-[12px]");
    expect(header.className).toContain("py-[10px]");
    expect(header.textContent).toContain("Team create");
    expect(header.textContent).toContain("2 args");
    expect(header.textContent).not.toContain("Done");
    expect(header.querySelector("[data-testid='tool-fallback-icon']")).toBeTruthy();
    expect(header.textContent).not.toContain("⚡");

    expect(screen.queryByText("Arguments")).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
  });

  it("renders question tools as a minimal summary card with only the question count", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "question",
      status: "completed",
      arguments: {
        questions: [
          { id: "q-1", question: "First?", options: [] },
          { id: "q-2", question: "Second?", options: [] },
          { id: "q-3", question: "Third?", options: [] },
        ],
      },
    })} />);

    const row = screen.getByTestId("tool-row-question");
    expect(row.textContent).toContain("Question");
    expect(row.textContent).toContain("3 questions");
    expect(row.textContent).not.toContain("args");
    expect(row.className).not.toContain("border");
    expect(row.className).not.toContain("bg-card");
    expect(screen.queryByText("Arguments")).toBeNull();
    expect(screen.queryByText("First?")).toBeNull();
  });

  it("shows a loading indicator while a question tool is preparing questions", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "question",
      status: "calling",
      arguments: {},
    })} />);

    const row = screen.getByTestId("tool-row-question");
    expect(row.textContent).toContain("Question");
    expect(row.textContent).not.toContain("0 questions");
    expect(screen.getByTestId("question-tool-loading").className.baseVal).toContain("animate-spin");
  });

  it("stops showing the question loading indicator once question data is available", () => {
    render(<ToolCallCard toolCall={makeToolCall({
      name: "question",
      status: "calling",
      arguments: {
        questions: [
          { id: "q-1", question: "First?", options: [] },
        ],
      },
    })} />);

    expect(screen.getByTestId("tool-row-question").textContent).toContain("1 question");
    expect(screen.queryByTestId("question-tool-loading")).toBeNull();
  });
});
