import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AcpEventSchema,
  EnvelopeSchema as AmuxEnvelopeSchema,
} from "@teamclaw/app/proto/amux_pb";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
} from "@teamclaw/app/proto/teamclaw_pb";
import type { SessionMessage, SessionSummary } from "../features/sessions/session-types";

function createSession(): SessionSummary {
  return {
    sessionId: "session-1",
    teamId: "team-1",
    title: "Session title",
    summary: "",
    participantCount: 2,
    participantActorIds: ["actor-1", "actor-agent"],
    lastMessagePreview: "Latest preview",
    lastMessageAt: "2026-05-19T08:20:00.000Z",
    createdAt: "2026-05-19T08:00:00.000Z",
    createdBy: "actor-1",
  };
}

function createRowMessage(messageId: string, senderActorId = "actor-1"): SessionMessage {
  return {
    content: `Message ${messageId}`,
    createdAt: "2026-05-19T08:20:00.000Z",
    kind: "text",
    messageId,
    metadata: null,
    model: "",
    replyToMessageId: "",
    senderActorId,
    sessionId: "session-1",
    teamId: "team-1",
    turnId: "",
  };
}

function createLivePayload(input: {
  content: string;
  createdAtSeconds?: bigint;
  messageId: string;
  senderActorId: string;
}) {
  const message = create(MessageSchema, {
    messageId: input.messageId,
    sessionId: "session-1",
    senderActorId: input.senderActorId,
    kind: MessageKind.TEXT,
    content: input.content,
    createdAt: input.createdAtSeconds ?? BigInt(1_747_642_000),
  });
  const sessionMessage = create(SessionMessageEnvelopeSchema, {
    message,
    mentionActorIds: [],
  });
  const envelope = create(LiveEventEnvelopeSchema, {
    eventId: `event-${input.messageId}`,
    eventType: "message.created",
    sessionId: "session-1",
    actorId: input.senderActorId,
    sentAt: input.createdAtSeconds ?? BigInt(1_747_642_000),
    body: toBinary(SessionMessageEnvelopeSchema, sessionMessage),
  });

  return toBinary(LiveEventEnvelopeSchema, envelope);
}

function createAcpOutputPayload(input: {
  actorId: string;
  eventId: string;
  isComplete?: boolean;
  model?: string;
  sequence?: bigint;
  text: string;
}) {
  const acpEvent = create(AcpEventSchema, {
    event: {
      case: "output",
      value: {
        text: input.text,
        isComplete: input.isComplete ?? false,
      },
    },
    model: input.model ?? "",
  });
  const amuxEnvelope = create(AmuxEnvelopeSchema, {
    runtimeId: "runtime-1",
    actorId: "actor-1",
    sequence: input.sequence ?? BigInt(1),
    timestamp: BigInt(1_747_642_000),
    payload: {
      case: "acpEvent",
      value: acpEvent,
    },
  });
  const liveEvent = create(LiveEventEnvelopeSchema, {
    eventId: input.eventId,
    eventType: "acp.event",
    sessionId: "session-1",
    actorId: input.actorId,
    sentAt: BigInt(1_747_642_000),
    body: toBinary(AmuxEnvelopeSchema, amuxEnvelope),
  });

  return toBinary(LiveEventEnvelopeSchema, liveEvent);
}

function createAcpThinkingPayload(input: {
  actorId: string;
  eventId: string;
  model?: string;
  sequence?: bigint;
  text: string;
}) {
  const acpEvent = create(AcpEventSchema, {
    event: {
      case: "thinking",
      value: {
        text: input.text,
      },
    },
    model: input.model ?? "",
  });
  const amuxEnvelope = create(AmuxEnvelopeSchema, {
    runtimeId: "runtime-1",
    actorId: "actor-1",
    sequence: input.sequence ?? BigInt(1),
    timestamp: BigInt(1_747_642_000),
    payload: {
      case: "acpEvent",
      value: acpEvent,
    },
  });
  const liveEvent = create(LiveEventEnvelopeSchema, {
    eventId: input.eventId,
    eventType: "acp.event",
    sessionId: "session-1",
    actorId: input.actorId,
    sentAt: BigInt(1_747_642_000),
    body: toBinary(AmuxEnvelopeSchema, amuxEnvelope),
  });

  return toBinary(LiveEventEnvelopeSchema, liveEvent);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createMockMqtt() {
  // Maps filter → handler. Uses the first registered handler per filter
  // for simplicity (the controller only subscribes once per topic).
  const topicHandlers = new Map<string, (payload: Uint8Array, topic: string) => void>();
  const connectionStateListeners = new Set<
    (state: "connecting" | "connected" | "disconnected") => void
  >();

  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((filter: string, handler: (payload: Uint8Array, topic: string) => void) => {
      topicHandlers.set(filter, handler);
      return () => {
        topicHandlers.delete(filter);
      };
    }),
    onConnectionState: vi.fn(
      (handler: (state: "connecting" | "connected" | "disconnected") => void) => {
        connectionStateListeners.add(handler);
        return () => {
          connectionStateListeners.delete(handler);
        };
      },
    ),
    /** Simulate an inbound MQTT message on a given topic. */
    emit(topic: string, payload: Uint8Array) {
      for (const [filter, handler] of topicHandlers) {
        // Simple exact-match check is sufficient for these tests.
        if (filter === topic) {
          handler(payload, topic);
        }
      }
    },
    emitConnectionState(state: "connecting" | "connected" | "disconnected") {
      for (const listener of connectionStateListeners) {
        listener(state);
      }
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSessionDetailController", () => {
  it("loads into ready state and connects realtime for the active session", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([createRowMessage("message-1")]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();

    expect(controller.getState()).toMatchObject({
      connectionState: "connected",
      messages: [expect.objectContaining({ messageId: "message-1" })],
      status: "ready",
    });
    expect(mqtt.subscribe).toHaveBeenCalledWith(
      "amux/team-1/session/session-1/live",
      expect.any(Function),
    );
  });

  it("optimistically appends a sent message and clears the composer text", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    controller.setComposerText("hello");
    await controller.sendMessage();

    expect(controller.getState().composerText).toBe("");
    expect(controller.getState().messages).toHaveLength(1);
    expect(controller.getState().messages[0]?.content).toBe("hello");
    expect(mqtt.publish).toHaveBeenCalledTimes(1);
  });

  it("mentions the sole agent participant when sending from the composer", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      getTeamActors: () => [
        {
          actorId: "actor-1",
          actorType: "member",
          avatarUrl: null,
          displayName: "Me",
          agentTypes: [],
          defaultAgentType: null,
          agentKind: null,
          lastActiveAt: null,
          role: null,
          teamId: "team-1",
        },
        {
          actorId: "actor-agent",
          actorType: "agent",
          avatarUrl: null,
          displayName: "Codex",
          agentTypes: ["codex"],
          defaultAgentType: "codex",
          agentKind: "codex",
          lastActiveAt: null,
          role: null,
          teamId: "team-1",
        },
      ],
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    } as any);

    await controller.load();
    controller.setComposerText("hello daemon");
    await controller.sendMessage();

    expect(api.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { mention_actor_ids: ["actor-agent"] },
      }),
    );
    expect(controller.getState().messages[0]).toMatchObject({
      metadata: { mention_actor_ids: ["actor-agent"] },
    });

    const publishBytes = mqtt.publish.mock.calls[0]?.[1] as Uint8Array;
    const live = fromBinary(LiveEventEnvelopeSchema, publishBytes);
    const sessionMessage = fromBinary(SessionMessageEnvelopeSchema, live.body);
    expect(sessionMessage.mentionActorIds).toEqual(["actor-agent"]);
  });

  it("sends a pending attachment even when composer text is empty", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const { appendPendingAttachment, takePendingAttachments } = await import(
      "../features/sessions/pending-attachments"
    );
    takePendingAttachments("team-1", "session-1");
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    appendPendingAttachment("team-1", "session-1", {
      path: "team-1/session-1/photo.png",
      publicUrl: "https://storage.example.test/photo.png?token=abc",
      mime: "image/png",
      size: 123,
    });
    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    await controller.sendMessage();

    expect(api.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "",
        attachments: [
          {
            url: "https://storage.example.test/photo.png?token=abc",
            path: "team-1/session-1/photo.png",
            mime: "image/png",
            size: 123,
          },
        ],
      }),
    );
    expect(controller.getState().messages[0]).toMatchObject({
      content: "",
      attachments: [
        {
          url: "https://storage.example.test/photo.png?token=abc",
          path: "team-1/session-1/photo.png",
        },
      ],
    });
    expect(takePendingAttachments("team-1", "session-1")).toHaveLength(0);
  });

  it("blocks sends until realtime has finished connecting", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    // Defer the second listMessages call (the one inside connectRealtime)
    // so the controller stays in "connecting" long enough to test the guard.
    const deferredListMessages = createDeferred<ReturnType<typeof createRowMessage>[]>();
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessages: vi.fn()
        .mockResolvedValueOnce([]) // first call (load phase)
        .mockReturnValueOnce(deferredListMessages.promise), // second call (connectRealtime)
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    const loadPromise = controller.load();
    // Flush enough microtasks so that connectRealtime has started but not finished.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.setComposerText("too early");
    await controller.sendMessage();

    // connectionState should not yet be "connected" so send is blocked.
    expect(controller.getState().sendErrorMessage).toMatch(/^实时连接/);
    expect(api.insertOutgoingMessage).not.toHaveBeenCalled();

    deferredListMessages.resolve([]);
    await loadPromise;
  });

  it("ignores duplicate mqtt messages by messageId", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([createRowMessage("message-1")]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createLivePayload({
        content: "duplicate",
        messageId: "message-1",
        senderActorId: "actor-agent",
      }),
    );

    expect(controller.getState().messages).toHaveLength(1);
  });

  it("merges a subsequent agent reply from mqtt", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createLivePayload({
        content: "agent reply",
        messageId: "agent-reply-1",
        senderActorId: "actor-agent",
      }),
    );

    expect(controller.getState().messages).toEqual([
      expect.objectContaining({
        content: "agent reply",
        messageId: "agent-reply-1",
        senderActorId: "actor-agent",
      }),
    ]);
  });

  it("streams acp output events into the agent buffer", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpOutputPayload({
        actorId: "actor-agent",
        eventId: "event-output-1",
        text: "Hel",
        sequence: BigInt(11),
      }),
    );
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpOutputPayload({
        actorId: "actor-agent",
        eventId: "event-output-2",
        text: "lo",
        sequence: BigInt(12),
        isComplete: true,
        model: "gpt-5.2",
      }),
    );

    const stream = controller.getState().streamingByAgent.get("actor-agent");
    expect(stream).toMatchObject({
      isComplete: true,
      kind: "agent_reply",
      model: "gpt-5.2",
      senderActorId: "actor-agent",
      text: "Hello",
    });
    expect(controller.getState().messages).toEqual([]);
  });

  it("preserves raw acp thinking chunks including leading spaces and punctuation", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpThinkingPayload({
        actorId: "actor-agent",
        eventId: "event-thinking-1",
        text: "I need",
        sequence: BigInt(21),
      }),
    );
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpThinkingPayload({
        actorId: "actor-agent",
        eventId: "event-thinking-2",
        text: " to inspect",
        sequence: BigInt(22),
      }),
    );
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createAcpThinkingPayload({
        actorId: "actor-agent",
        eventId: "event-thinking-3",
        text: ".",
        sequence: BigInt(23),
      }),
    );

    expect(controller.getState().messages.map((message) => message.content)).toEqual([
      "I need",
      " to inspect",
      ".",
    ]);
  });

  it("replays persisted messages fetched after subscribe to close the load gap", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([createRowMessage("message-gap", "actor-agent")]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();

    expect(api.listMessages).toHaveBeenCalledTimes(2);
    expect(controller.getState().messages).toEqual([
      expect.objectContaining({ messageId: "message-gap" }),
    ]);
  });

  it("keeps the current session visible while a pull refresh is in flight", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const deferredRefreshMessages = createDeferred<ReturnType<typeof createRowMessage>[]>();
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi
        .fn()
        .mockResolvedValueOnce([createRowMessage("message-1")])
        .mockResolvedValueOnce([createRowMessage("message-1")])
        .mockReturnValueOnce(deferredRefreshMessages.promise)
        .mockResolvedValueOnce([createRowMessage("message-2", "actor-agent")]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    const refreshPromise = controller.load({ preserveExisting: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getState()).toMatchObject({
      isRefreshing: true,
      messages: [expect.objectContaining({ messageId: "message-1" })],
      session: expect.objectContaining({ sessionId: "session-1" }),
      status: "ready",
    });

    deferredRefreshMessages.resolve([createRowMessage("message-2", "actor-agent")]);
    await refreshPromise;

    expect(controller.getState()).toMatchObject({
      isRefreshing: false,
      messages: [expect.objectContaining({ messageId: "message-2" })],
      status: "ready",
    });
  });

  it("preserves composer text when send insert fails", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockRejectedValue(new Error("insert failed")),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    controller.setComposerText("still here");
    await controller.sendMessage();

    expect(controller.getState()).toMatchObject({
      composerText: "still here",
      sendErrorMessage: "insert failed",
    });
  });

  it("does not let stale connect completions mutate a disposed controller", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    // Defer the second listMessages call inside connectRealtime so we can
    // dispose the controller while it is still mid-flight.
    const deferredListMessages = createDeferred<ReturnType<typeof createRowMessage>[]>();
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn()
        .mockResolvedValueOnce([]) // first call (load phase)
        .mockReturnValueOnce(deferredListMessages.promise), // second call (connectRealtime)
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    const loadPromise = controller.load();
    controller.dispose();
    deferredListMessages.resolve([]);
    await loadPromise;

    expect(controller.getState().connectionState).toBe("disconnected");
  });

  it("downgrades the connection state when realtime drops after load", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emitConnectionState("disconnected");

    expect(controller.getState().connectionState).toBe("disconnected");
  });
});
