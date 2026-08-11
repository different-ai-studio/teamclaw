import { describe, expect, it } from "vitest";

import {
  sortTurnEvents,
  turnModelName,
} from "../features/sessions/turn-detail-events";
import type { SessionMessage } from "../features/sessions/session-types";

function event(partial: Partial<SessionMessage> = {}): SessionMessage {
  return {
    messageId: "m1",
    sessionId: "s1",
    teamId: "t1",
    senderActorId: "agent1",
    kind: "agent_reply",
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

describe("sortTurnEvents", () => {
  it("puts a turn back in chronological order", () => {
    // Live MQTT deltas race the requestTurnHistory backfill, so arrival order
    // can put a tool call above the text that asked for it.
    const sorted = sortTurnEvents([
      event({ messageId: "c", createdAt: "2026-01-01T00:00:03Z" }),
      event({ messageId: "a", createdAt: "2026-01-01T00:00:01Z" }),
      event({ messageId: "b", createdAt: "2026-01-01T00:00:02Z" }),
    ]);
    expect(sorted.map((e) => e.messageId)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties on message id so the order is stable", () => {
    const sorted = sortTurnEvents([
      event({ messageId: "z" }),
      event({ messageId: "a" }),
      event({ messageId: "m" }),
    ]);
    expect(sorted.map((e) => e.messageId)).toEqual(["a", "m", "z"]);
  });

  it("does not mutate its input", () => {
    const input = [event({ messageId: "b" }), event({ messageId: "a" })];
    sortTurnEvents(input);
    expect(input.map((e) => e.messageId)).toEqual(["b", "a"]);
  });

  it("handles the empty and single-event cases", () => {
    expect(sortTurnEvents([])).toEqual([]);
    expect(sortTurnEvents([event({ messageId: "only" })]).map((e) => e.messageId)).toEqual([
      "only",
    ]);
  });
});

describe("turnModelName", () => {
  it("takes the newest event that names a model", () => {
    expect(
      turnModelName([
        event({ model: "claude-sonnet-4-5" }),
        event({ model: "claude-sonnet-4-6" }),
      ]),
    ).toBe("claude-sonnet-4-6");
  });

  it("walks back past events that carry no model", () => {
    // Tool and status events are not model-attributable.
    expect(
      turnModelName([
        event({ model: "claude-sonnet-4-6" }),
        event({ kind: "agent_tool_call", model: "" }),
        event({ kind: "agent_tool_result", model: "" }),
      ]),
    ).toBe("claude-sonnet-4-6");
  });

  it("is null when nothing in the turn names one", () => {
    expect(turnModelName([])).toBeNull();
    expect(turnModelName([event({ model: "" }), event({ model: "   " })])).toBeNull();
  });
});
