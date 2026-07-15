import { describe, expect, it } from "vitest";

import {
  deriveAgentPlanSnapshots,
  parseTodoText,
} from "../features/sessions/plan-snapshot";
import type { SessionMessage } from "../features/sessions/session-types";

function planMessage(
  partial: Partial<SessionMessage> & { senderActorId: string; content: string },
): SessionMessage {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "s1",
    teamId: "t1",
    kind: "plan_update",
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: null,
    model: "",
    replyToMessageId: "",
    turnId: "",
    ...partial,
  };
}

describe("parseTodoText", () => {
  it("returns empty list for blank text", () => {
    expect(parseTodoText("")).toEqual([]);
    expect(parseTodoText("   \n\t  \n")).toEqual([]);
  });

  it("recognises [done] / [wip] / [todo] / [cancelled] prefixes", () => {
    const items = parseTodoText(
      "[done] write the prd\n[wip] sketch UI\n[todo] write tests\n[cancelled] migrate db",
    );
    expect(items).toEqual([
      { content: "write the prd", status: "completed" },
      { content: "sketch UI", status: "in_progress" },
      { content: "write tests", status: "pending" },
      { content: "migrate db", status: "cancelled" },
    ]);
  });

  it("treats lines without a recognized prefix as pending", () => {
    expect(parseTodoText("plain line")).toEqual([
      { content: "plain line", status: "pending" },
    ]);
  });

  it("is case-insensitive on the prefix", () => {
    expect(parseTodoText("[DONE] ok\n[Wip] hmm")).toEqual([
      { content: "ok", status: "completed" },
      { content: "hmm", status: "in_progress" },
    ]);
  });

  it("skips blank lines between items", () => {
    expect(parseTodoText("[todo] a\n\n[done] b")).toEqual([
      { content: "a", status: "pending" },
      { content: "b", status: "completed" },
    ]);
  });
});

describe("deriveAgentPlanSnapshots", () => {
  it("returns no snapshots when there are no plan_update messages", () => {
    const messages: SessionMessage[] = [
      planMessage({
        senderActorId: "agent-1",
        content: "[todo] foo",
        kind: "text",
      }),
    ];
    expect(deriveAgentPlanSnapshots(messages, () => "Claude")).toEqual([]);
  });

  it("keeps only the latest plan per agent", () => {
    const messages: SessionMessage[] = [
      planMessage({
        senderActorId: "agent-1",
        content: "[todo] step 1",
      }),
      planMessage({
        senderActorId: "agent-1",
        content: "[done] step 1\n[todo] step 2",
      }),
    ];
    const snapshots = deriveAgentPlanSnapshots(messages, () => "Claude");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].items).toEqual([
      { content: "step 1", status: "completed" },
      { content: "step 2", status: "pending" },
    ]);
  });

  it("drops agents whose latest plan has no unfinished items", () => {
    const messages: SessionMessage[] = [
      planMessage({ senderActorId: "agent-1", content: "[done] done" }),
      planMessage({ senderActorId: "agent-2", content: "[todo] open" }),
    ];
    const snapshots = deriveAgentPlanSnapshots(messages, (id) =>
      id === "agent-1" ? "Claude" : "OpenCode",
    );
    expect(snapshots.map((s) => s.agentId)).toEqual(["agent-2"]);
  });

  it("orders snapshots by each agent's first plan_update appearance", () => {
    const messages: SessionMessage[] = [
      planMessage({ senderActorId: "agent-2", content: "[todo] b" }),
      planMessage({ senderActorId: "agent-1", content: "[todo] a" }),
      planMessage({
        senderActorId: "agent-2",
        content: "[todo] still working",
      }),
    ];
    const snapshots = deriveAgentPlanSnapshots(messages, (id) => id);
    expect(snapshots.map((s) => s.agentId)).toEqual(["agent-2", "agent-1"]);
  });

  it("falls back to the actor id when the name lookup is empty", () => {
    const messages: SessionMessage[] = [
      planMessage({ senderActorId: "agent-1", content: "[todo] thing" }),
    ];
    const snapshots = deriveAgentPlanSnapshots(messages, () => "");
    expect(snapshots[0].agentName).toBe("agent-1");
  });

  it("ignores plan messages with empty content", () => {
    const messages: SessionMessage[] = [
      planMessage({ senderActorId: "agent-1", content: "   " }),
    ];
    expect(deriveAgentPlanSnapshots(messages, () => "Claude")).toEqual([]);
  });
});
