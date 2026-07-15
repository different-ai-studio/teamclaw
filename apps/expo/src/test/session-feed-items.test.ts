import { describe, expect, it } from "vitest";

import { buildSessionFeedSources } from "../features/sessions/session-feed-items";
import type { SessionMessage, StreamingBuffer } from "../features/sessions/session-types";

function message(
  id: string,
  kind: string,
  content: string,
  createdAt: string,
  senderActorId = "agent-1",
  turnId = "",
): SessionMessage {
  return {
    content,
    createdAt,
    kind,
    messageId: id,
    metadata: null,
    model: kind === "agent_reply" ? "gpt-5.2" : "",
    replyToMessageId: "",
    senderActorId,
    sessionId: "session-1",
    teamId: "team-1",
    turnId,
  };
}

describe("buildSessionFeedSources", () => {
  it("groups runtime detail and the final agent reply into one completed turn", () => {
    const sources = buildSessionFeedSources(
      [
        message("user-1", "text", "Please inspect this", "2026-05-20T10:00:00.000Z", "me"),
        message("think-1", "agent_thinking", "I should inspect the files", "2026-05-20T10:00:01.000Z"),
        message("tool-1", "agent_tool_call", "rg query", "2026-05-20T10:00:02.000Z"),
        message("result-1", "agent_tool_result", "3 matches", "2026-05-20T10:00:03.000Z"),
        message("plan-1", "plan_update", "[wip] implement", "2026-05-20T10:00:04.000Z"),
        message("reply-1", "agent_reply", "Done.", "2026-05-20T10:00:05.000Z"),
      ],
      new Map(),
      { ownActorId: "me" },
    );

    expect(sources.map((item) => item.kind)).toEqual(["message", "agentTurn"]);
    expect(sources[1]).toMatchObject({
      kind: "agentTurn",
      turn: {
        agentId: "agent-1",
        isActive: false,
        finalMessage: expect.objectContaining({ messageId: "reply-1" }),
        runtimeEvents: [
          expect.objectContaining({ messageId: "think-1" }),
          expect.objectContaining({ messageId: "tool-1" }),
          expect.objectContaining({ messageId: "result-1" }),
          expect.objectContaining({ messageId: "plan-1" }),
        ],
      },
    });
  });

  it("keeps permission requests in the main feed while grouping surrounding runtime detail", () => {
    const sources = buildSessionFeedSources(
      [
        message("think-1", "agent_thinking", "Need permission", "2026-05-20T10:00:01.000Z"),
        message("perm-1", "permission_request", "Allow file write?", "2026-05-20T10:00:02.000Z"),
        message("result-1", "agent_tool_result", "Permission granted", "2026-05-20T10:00:03.000Z"),
        message("reply-1", "agent_reply", "Finished.", "2026-05-20T10:00:04.000Z"),
      ],
      new Map(),
    );

    expect(sources.map((item) => item.kind)).toEqual(["message", "agentTurn"]);
    expect(sources[0]).toMatchObject({
      kind: "message",
      message: expect.objectContaining({ messageId: "perm-1" }),
    });
    expect(sources[1]).toMatchObject({
      kind: "agentTurn",
      turn: {
        runtimeEvents: [
          expect.objectContaining({ messageId: "think-1" }),
          expect.objectContaining({ messageId: "result-1" }),
        ],
      },
    });
  });

  it("creates one active turn for open runtime events plus the live stream buffer", () => {
    const stream: StreamingBuffer = {
      isComplete: false,
      kind: "agent_reply",
      messageId: "stream-1",
      model: "gpt-5.2",
      senderActorId: "agent-1",
      startedAt: "2026-05-20T10:00:02.000Z",
      text: "Partial response",
    };

    const sources = buildSessionFeedSources(
      [
        message("think-1", "agent_thinking", ".", "2026-05-20T10:00:01.000Z"),
        message("tool-1", "agent_tool_call", "read file", "2026-05-20T10:00:02.000Z"),
      ],
      new Map([["agent-1", stream]]),
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      kind: "agentTurn",
      turn: {
        agentId: "agent-1",
        isActive: true,
        runtimeEvents: [
          expect.objectContaining({ messageId: "think-1" }),
          expect.objectContaining({ messageId: "tool-1" }),
        ],
        stream: expect.objectContaining({ text: "Partial response" }),
      },
    });
  });

  it("merges split final agent replies that share the same turn id", () => {
    const sources = buildSessionFeedSources(
      [
        message("think-1", "agent_thinking", "I will use a tool", "2026-05-20T10:00:01.000Z", "agent-1", "turn-1"),
        message("reply-1", "agent_reply", "First part. ", "2026-05-20T10:00:02.000Z", "agent-1", "turn-1"),
        message("reply-2", "agent_reply", "Second part.", "2026-05-20T10:00:03.000Z", "agent-1", "turn-1"),
      ],
      new Map(),
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      kind: "agentTurn",
      key: "agentTurn:agent-1:turn-1",
      turn: {
        finalMessage: expect.objectContaining({
          content: "First part. Second part.",
          messageId: "reply-2",
        }),
        runtimeEvents: [expect.objectContaining({ messageId: "think-1" })],
      },
    });
  });
});
