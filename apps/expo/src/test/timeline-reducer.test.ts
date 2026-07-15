import { describe, expect, it } from "vitest";

import { emptyTimelineState, reduceTimeline } from "../features/sessions/timeline-reducer";
import type { SessionMessage } from "../features/sessions/session-types";

function msg(id: string, content: string, createdAt = "2026-05-20T10:00:00.000Z"): SessionMessage {
  return {
    content, createdAt, kind: "text", messageId: id, metadata: null,
    model: "", replyToMessageId: "", senderActorId: "agent-1",
    sessionId: "s", teamId: "t", turnId: "",
  };
}

describe("reduceTimeline · messageCommitted", () => {
  it("inserts a new message sorted by createdAt", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "first", "2026-05-20T10:00:00.000Z") });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("b", "second", "2026-05-20T10:01:00.000Z") });
    expect(s.messages.map((m) => m.messageId)).toEqual(["a", "b"]);
  });

  it("replaces existing row when content is longer (streaming converges)", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hel") });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello world") });
    expect(s.messages[0].content).toBe("Hello world");
  });

  it("ignores recommit with shorter or equal content", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello world") });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello") });
    expect(s.messages[0].content).toBe("Hello world");
  });

  it("clears streamingByAgent entry that committed", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, {
      kind: "streamingDelta", agentId: "agent-1", messageId: "a",
      messageKind: "agent_reply", deltaText: "Hel", createdAt: "2026-05-20T10:00:00.000Z",
    });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello") });
    expect(s.streamingByAgent.has("agent-1")).toBe(false);
  });

  it("clears an agent stream when the committed message has a different persisted id", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, {
      kind: "streamingDelta", agentId: "agent-1", messageId: "acp:agent-1:1",
      messageKind: "agent_reply", deltaText: "Hello", createdAt: "2026-05-20T10:00:00.000Z",
    });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("db-message-1", "Hello") });
    expect(s.streamingByAgent.has("agent-1")).toBe(false);
  });
});

describe("reduceTimeline · streamingDelta", () => {
  it("appends delta into a buffer keyed by agentId", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "Hel", createdAt: "2026-05-20T10:00:00.000Z" });
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "lo", createdAt: "2026-05-20T10:00:00.500Z" });
    expect(s.streamingByAgent.get("a")?.text).toBe("Hello");
  });

  it("two agents stream independently", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "Hi", createdAt: "2026-05-20T10:00:00.000Z" });
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "b", messageId: "m2",
      messageKind: "agent_reply", deltaText: "Sup", createdAt: "2026-05-20T10:00:00.000Z" });
    expect(s.streamingByAgent.get("a")?.text).toBe("Hi");
    expect(s.streamingByAgent.get("b")?.text).toBe("Sup");
  });

  it("does not modify messages array", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "Hi", createdAt: "2026-05-20T10:00:00.000Z" });
    expect(s.messages).toEqual([]);
  });

  it("marks an output buffer complete without clearing the visible text", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "Hel", createdAt: "2026-05-20T10:00:00.000Z" });
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "lo", createdAt: "2026-05-20T10:00:01.000Z", isComplete: true,
      model: "gpt-5.2" });

    expect(s.streamingByAgent.get("a")).toMatchObject({
      isComplete: true,
      model: "gpt-5.2",
      text: "Hello",
    });
  });
});

describe("reduceTimeline · streamingDone", () => {
  it("clears the agent's buffer", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "streamingDelta", agentId: "a", messageId: "m1",
      messageKind: "agent_reply", deltaText: "Hi", createdAt: "2026-05-20T10:00:00.000Z" });
    s = reduceTimeline(s, { kind: "streamingDone", agentId: "a", messageId: "m1" });
    expect(s.streamingByAgent.has("a")).toBe(false);
  });
});
