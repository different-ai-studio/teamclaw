import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/stores/session";
import { isCommandToolLikelyWaitingForInput } from "../tool-calls/tool-call-utils";
import {
  getCommandText,
  getToolCallOutputText,
} from "@/lib/terminal-interaction";

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc-1",
    name: "bash",
    status: "calling",
    arguments: {},
    startTime: new Date(),
    ...overrides,
  };
}

describe("tool-call-utils", () => {
  it("extracts command text from common argument keys", () => {
    expect(getCommandText({ command: "pnpm install" })).toBe("pnpm install");
    expect(getCommandText({ cmd: "npm test" })).toBe("npm test");
    expect(getCommandText({ input: "git status" })).toBe("git status");
  });

  it("extracts output text from structured tool results", () => {
    expect(getToolCallOutputText({ output: "hello" })).toBe("hello");
    expect(getToolCallOutputText({ raw: "world" })).toBe("world");
    expect(getToolCallOutputText("plain")).toBe("plain");
  });

  it("does not flag prompt-like command output anymore", () => {
    const toolCall = makeToolCall({
      result: "This will remove files. Continue? [y/N]",
    });

    expect(isCommandToolLikelyWaitingForInput(toolCall)).toBe(false);
  });

  it("does not flag completed or normal command output", () => {
    const completedToolCall = makeToolCall({
      status: "completed",
      result: "Done",
    });
    const normalRunningToolCall = makeToolCall({
      result: "Installing dependencies...\nFetched 14 packages",
    });

    expect(isCommandToolLikelyWaitingForInput(completedToolCall)).toBe(false);
    expect(isCommandToolLikelyWaitingForInput(normalRunningToolCall)).toBe(false);
  });
});
