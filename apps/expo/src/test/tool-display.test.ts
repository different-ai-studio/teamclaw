import { beforeEach, describe, expect, it } from "vitest";

import {
  foldToolResults,
  toolCallPresentation,
  toolSummary,
  __resetToolSummaryCache,
} from "../features/sessions/tool-display";
import type { SessionMessage } from "../features/sessions/session-types";

beforeEach(() => {
  __resetToolSummaryCache();
});

function message(partial: Partial<SessionMessage> = {}): SessionMessage {
  return {
    messageId: "m1",
    sessionId: "s1",
    teamId: "t1",
    senderActorId: "agent1",
    kind: "agent_tool_call",
    content: "",
    model: "",
    turnId: "",
    replyToMessageId: "",
    metadata: null,
    createdAt: "2026-01-01T00:00:00Z",
    attachments: [],
    ...partial,
  };
}

describe("toolSummary", () => {
  it("has nothing to say about empty or empty-ish arguments", () => {
    // These three also make a row non-expandable on iOS.
    expect(toolSummary("")).toBeNull();
    expect(toolSummary("   ")).toBeNull();
    expect(toolSummary("{}")).toBeNull();
    expect(toolSummary("null")).toBeNull();
  });

  it("prefers the keys a reader recognises a call by", () => {
    // `zebra` sorts last but `file_path` is what identifies the call.
    expect(toolSummary('{"zebra":"z","file_path":"/src/app.ts"}')).toBe(
      "file path: /src/app.ts",
    );
  });

  it("keeps the preferred order rather than the object's", () => {
    expect(toolSummary('{"query":"needle","path":"/src"}')).toBe(
      "path: /src · query: needle",
    );
  });

  it("shows at most two pairs", () => {
    const summary = toolSummary('{"path":"/a","query":"b","command":"c"}');
    expect(summary).toBe("path: /a · query: b");
  });

  it("falls back to sorted keys when nothing is preferred", () => {
    expect(toolSummary('{"beta":"2","alpha":"1"}')).toBe("alpha: 1 · beta: 2");
  });

  it("counts arrays instead of listing them", () => {
    expect(toolSummary('{"items":[1,2,3]}')).toBe("items: 3 items");
    expect(toolSummary("[1,2,3,4]")).toBe("4 items");
  });

  it("reaches one level into a nested object for a name", () => {
    expect(toolSummary('{"target":{"path":"/deep/file.ts"}}')).toBe(
      "target: /deep/file.ts",
    );
  });

  it("gives up on a nested object with nothing nameable", () => {
    expect(toolSummary('{"opts":{"verbose":true}}')).toBeNull();
  });

  it("flattens non-JSON text onto one line and truncates it", () => {
    expect(toolSummary("line one\nline two")).toBe("line one line two");
    const long = "x".repeat(200);
    const summary = toolSummary(long);
    expect(summary).toHaveLength(80);
    expect(summary?.endsWith("…")).toBe(true);
  });

  it("truncates a long value inside a pair", () => {
    const summary = toolSummary(JSON.stringify({ path: "y".repeat(100) }));
    // 48-char budget per value, ellipsis included.
    expect(summary).toBe(`path: ${"y".repeat(47)}…`);
  });

  it("skips values that render to nothing", () => {
    expect(toolSummary('{"path":"   ","query":"real"}')).toBe("query: real");
  });

  it("answers repeated calls consistently", () => {
    // The cache is keyed on the description, and this is the hot path — every
    // re-render of a visible row asks again.
    const args = '{"path":"/src/app.ts"}';
    expect(toolSummary(args)).toBe(toolSummary(args));
  });
});

describe("toolCallPresentation", () => {
  it("uppercases the tool name and summarises the params", () => {
    const presentation = toolCallPresentation(
      message({
        content: "Read /src/app.ts",
        metadata: { tool_name: "read", tool_id: "t-1", params: { file_path: "/src/app.ts" } },
      }),
    );
    expect(presentation.label).toBe("READ");
    expect(presentation.toolId).toBe("t-1");
    expect(presentation.summary).toBe("file path: /src/app.ts");
  });

  it("falls back to the tool id when there is no name", () => {
    const presentation = toolCallPresentation(
      message({ metadata: { tool_id: "toolu_123", params: { path: "/x" } } }),
    );
    expect(presentation.label).toBe("TOOLU_123");
  });

  it("uses the message content when there are no structured params", () => {
    const presentation = toolCallPresentation(
      message({ content: "Bash ls -la", metadata: { tool_name: "bash", params: {} } }),
    );
    expect(presentation.description).toBe("Bash ls -la");
    expect(presentation.summary).toBe("Bash ls -la");
  });

  it("reads as running until a result arrives", () => {
    expect(toolCallPresentation(message()).status).toBe("running");
  });

  it("distinguishes a completed tool from a failed one", () => {
    expect(
      toolCallPresentation(message(), { summary: "ok", success: true }).status,
    ).toBe("completed");
    expect(
      toolCallPresentation(message(), { summary: "boom", success: false }).status,
    ).toBe("failed");
  });
});

describe("foldToolResults", () => {
  const call = message({
    messageId: "call-1",
    kind: "agent_tool_call",
    metadata: { tool_id: "t-1", tool_name: "bash" },
  });

  it("pairs a result with the call it answers", () => {
    const result = message({
      messageId: "result-1",
      kind: "agent_tool_result",
      content: "exit 0",
      metadata: { tool_id: "t-1", success: true },
    });
    const folded = foldToolResults([call, result]);
    expect(folded.resultByToolId.get("t-1")).toEqual({ summary: "exit 0", success: true });
    expect(folded.foldedMessageIds.has("result-1")).toBe(true);
  });

  it("carries the failure through — this is the whole point", () => {
    const failure = message({
      messageId: "result-1",
      kind: "agent_tool_result",
      content: "command not found",
      metadata: { tool_id: "t-1", success: false },
    });
    expect(foldToolResults([call, failure]).resultByToolId.get("t-1")?.success).toBe(false);
  });

  it("treats a missing success flag as not-a-failure", () => {
    const result = message({
      messageId: "result-1",
      kind: "agent_tool_result",
      content: "done",
      metadata: { tool_id: "t-1" },
    });
    expect(foldToolResults([call, result]).resultByToolId.get("t-1")?.success).toBe(true);
  });

  it("leaves an orphan result in the feed rather than swallowing it", () => {
    // Its call is outside the loaded window, so folding it would lose it.
    const orphan = message({
      messageId: "result-9",
      kind: "agent_tool_result",
      content: "late",
      metadata: { tool_id: "t-unknown" },
    });
    const folded = foldToolResults([call, orphan]);
    expect(folded.foldedMessageIds.size).toBe(0);
    expect(folded.resultByToolId.size).toBe(0);
  });

  it("ignores a result with no tool id at all", () => {
    const noId = message({ messageId: "r", kind: "agent_tool_result", metadata: {} });
    expect(foldToolResults([call, noId]).foldedMessageIds.size).toBe(0);
  });

  it("keeps the last result when a tool id repeats", () => {
    const first = message({
      messageId: "r1",
      kind: "agent_tool_result",
      content: "first",
      metadata: { tool_id: "t-1" },
    });
    const second = message({
      messageId: "r2",
      kind: "agent_tool_result",
      content: "second",
      metadata: { tool_id: "t-1" },
    });
    const folded = foldToolResults([call, first, second]);
    expect(folded.resultByToolId.get("t-1")?.summary).toBe("second");
    expect(folded.foldedMessageIds.size).toBe(2);
  });

  it("does nothing to a timeline with no tools in it", () => {
    const text = message({ messageId: "m", kind: "text", content: "hi" });
    const folded = foldToolResults([text]);
    expect(folded.resultByToolId.size).toBe(0);
    expect(folded.foldedMessageIds.size).toBe(0);
  });
});
