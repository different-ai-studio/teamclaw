import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionSummary } from "../features/sessions/session-types";

function createSession(): SessionSummary {
  return {
    sessionId: "session-1",
    teamId: "team-1",
    title: "Session title",
    summary: "Session summary",
    participantCount: 2,
    participantActorIds: ["actor-1", "actor-2"],
    lastMessagePreview: "Latest preview",
    lastMessageAt: "2026-05-18T08:20:00.000Z",
    createdAt: "2026-05-18T08:00:00.000Z",
    createdBy: "actor-1",
  };
}

function createMessage(messageId: string): SessionMessage {
  return {
    content: `Message ${messageId}`,
    createdAt: "2026-05-18T08:20:00.000Z",
    kind: "text",
    messageId,
    metadata: null,
    model: "",
    replyToMessageId: "",
    senderActorId: "actor-1",
    sessionId: "session-1",
    teamId: "team-1",
    turnId: "turn-1",
  };
}

describe("buildSessionDetailState", () => {
  it("returns the empty state when a session has no messages", async () => {
    const { buildSessionDetailState } = await import("../features/sessions/session-types");

    expect(buildSessionDetailState(createSession(), [])).toEqual({
      status: "empty",
      session: createSession(),
      messages: [],
      errorMessage: null,
    });
  });

  it("returns the ready state with raw persisted message rows when a session has messages", async () => {
    const { buildSessionDetailState } = await import("../features/sessions/session-types");
    const session = createSession();
    const messages = [createMessage("message-1"), createMessage("message-2")];
    const state = buildSessionDetailState(session, messages);

    expect(state).toEqual({
      status: "ready",
      session,
      messages,
      errorMessage: null,
    });
    expect(state.messages).toBe(messages);
  });
});
