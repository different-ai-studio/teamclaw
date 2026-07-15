import { describe, expect, it } from "vitest";

import { buildAgentTurnDetailGroups } from "../features/sessions/session-turn-detail";
import type { SessionMessage } from "../features/sessions/session-types";

function event(
  id: string,
  kind: string,
  content: string,
  createdAt = "2026-05-20T10:00:00.000Z",
  metadata: unknown = null,
): SessionMessage {
  return {
    content,
    createdAt,
    kind,
    messageId: id,
    metadata,
    model: "",
    replyToMessageId: "",
    senderActorId: "agent-1",
    sessionId: "session-1",
    teamId: "team-1",
    turnId: "turn-1",
  };
}

describe("buildAgentTurnDetailGroups", () => {
  it("merges multiple thinking events into one readable sentence", () => {
    const groups = buildAgentTurnDetailGroups([
      event("think-1", "agent_thinking", "I need to inspect the code."),
      event("think-2", "agent_thinking", "Then I should patch the UI."),
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        body: "I need to inspect the code. Then I should patch the UI.",
        count: 2,
        eventIds: ["think-1", "think-2"],
        kind: "thinking",
        title: "Thinking",
      }),
    ]);
  });

  it("concatenates streaming thinking fragments without inserting line breaks", () => {
    const groups = buildAgentTurnDetailGroups([
      event("think-1", "agent_thinking", "I need "),
      event("think-2", "agent_thinking", "to inspect "),
      event("think-3", "agent_thinking", "the code."),
    ]);

    expect(groups[0]).toMatchObject({
      body: "I need to inspect the code.",
      count: 3,
      kind: "thinking",
    });
  });

  it("preserves whitespace and punctuation chunks inside streamed thinking", () => {
    const groups = buildAgentTurnDetailGroups([
      event("think-1", "agent_thinking", "I need"),
      event("think-2", "agent_thinking", " to inspect"),
      event("think-3", "agent_thinking", "."),
    ]);

    expect(groups[0]).toMatchObject({
      body: "I need to inspect.",
      count: 3,
      kind: "thinking",
    });
  });

  it("shows punctuation-only thinking as a single working placeholder", () => {
    const groups = buildAgentTurnDetailGroups([
      event("think-1", "agent_thinking", "."),
      event("think-2", "agent_thinking", "…"),
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        body: "Working…",
        count: 2,
        kind: "thinking",
      }),
    ]);
  });

  it("drops placeholder thinking once real thinking text arrives", () => {
    const groups = buildAgentTurnDetailGroups([
      event("think-1", "agent_thinking", "."),
      event("think-2", "agent_thinking", "question"),
    ]);

    expect(groups[0]).toMatchObject({
      body: "question",
      count: 2,
      kind: "thinking",
    });
  });

  it("merges tool calls and results into one tools block", () => {
    const groups = buildAgentTurnDetailGroups([
      event("tool-1", "agent_tool_call", "Read file", "2026-05-20T10:00:01.000Z", {
        tool_name: "read_file",
      }),
      event("result-1", "agent_tool_result", "Loaded 24 lines", "2026-05-20T10:00:02.000Z"),
      event("tool-2", "agent_tool_call", "Search usages", "2026-05-20T10:00:03.000Z", {
        tool_name: "rg",
      }),
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        body: "read_file: Read file\n\nTool result: Loaded 24 lines\n\nrg: Search usages",
        count: 3,
        eventIds: ["tool-1", "result-1", "tool-2"],
        kind: "tools",
        title: "Tools",
      }),
    ]);
  });

  it("collapses plan updates into one latest plan block", () => {
    const groups = buildAgentTurnDetailGroups([
      event("plan-1", "plan_update", "[wip] inspect\n[todo] patch"),
      event("plan-2", "plan_update", "[done] inspect\n[wip] patch"),
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        body: "[done] inspect\n[wip] patch",
        count: 2,
        eventIds: ["plan-1", "plan-2"],
        kind: "plan",
        title: "Plan",
      }),
    ]);
  });
});
