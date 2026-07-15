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

function fulfilled<T>(value: T): PromiseFulfilledResult<T> {
  return {
    status: "fulfilled",
    value,
  };
}

function rejected(reason: unknown): PromiseRejectedResult {
  return {
    status: "rejected",
    reason,
  };
}

describe("reduceSessionDetailRouteState", () => {
  it("returns empty when the session exists and there are no messages", async () => {
    const { reduceSessionDetailRouteState } = await import("../features/sessions/session-types");
    const session = createSession();

    expect(
      reduceSessionDetailRouteState(fulfilled(session), fulfilled([])),
    ).toEqual({
      status: "empty",
      session,
      messages: [],
      errorMessage: null,
    });
  });

  it("returns ready when the session exists and messages are available", async () => {
    const { reduceSessionDetailRouteState } = await import("../features/sessions/session-types");
    const session = createSession();
    const messages = [createMessage("message-1")];

    expect(
      reduceSessionDetailRouteState(fulfilled(session), fulfilled(messages)),
    ).toEqual({
      status: "ready",
      session,
      messages,
      errorMessage: null,
    });
  });

  it("returns error while preserving session metadata when messages fail", async () => {
    const { reduceSessionDetailRouteState } = await import("../features/sessions/session-types");
    const session = createSession();

    expect(
      reduceSessionDetailRouteState(
        fulfilled(session),
        rejected(new Error("messages exploded")),
      ),
    ).toEqual({
      status: "error",
      session,
      messages: [],
      errorMessage: "messages exploded",
    });
  });

  it("returns not-found when the session lookup succeeds with no session", async () => {
    const { reduceSessionDetailRouteState } = await import("../features/sessions/session-types");

    expect(
      reduceSessionDetailRouteState(fulfilled(null), fulfilled([createMessage("message-1")])),
    ).toEqual({
      status: "not-found",
      session: null,
      messages: [],
      errorMessage: null,
    });
  });

  it("returns an error without preserved messages when the session lookup fails", async () => {
    const { reduceSessionDetailRouteState } = await import("../features/sessions/session-types");

    expect(
      reduceSessionDetailRouteState(
        rejected(new Error("session exploded")),
        fulfilled([createMessage("message-1")]),
      ),
    ).toEqual({
      status: "error",
      session: null,
      messages: [],
      errorMessage: "session exploded",
    });
  });
});
