import { describe, expect, it } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";

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
import { decodeLiveEvent, sessionIdFromTopic } from "../lib/teamclaw/live-events";

describe("decodeLiveEvent", () => {
  it("decodes valid message.created payloads", () => {
    const message = create(MessageSchema, {
      messageId: "message-1",
      sessionId: "session-1",
      senderActorId: "actor-1",
      kind: MessageKind.TEXT,
      content: "hello world",
      createdAt: BigInt(1000),
    });

    const sessionMessage = create(SessionMessageEnvelopeSchema, {
      message,
    });

    const liveEvent = create(LiveEventEnvelopeSchema, {
      eventId: "event-1",
      eventType: "message.created",
      sessionId: "session-1",
      actorId: "actor-1",
      sentAt: BigInt(1000),
      body: toBinary(SessionMessageEnvelopeSchema, sessionMessage),
    });

    const decoded = decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, liveEvent));

    expect(decoded).not.toBeNull();
    expect(decoded?.envelope.eventType).toBe("message.created");
    expect(decoded?.sessionMessage?.message?.messageId).toBe("message-1");
    expect(decoded?.message?.content).toBe("hello world");
  });

  it("returns null for invalid live envelopes", () => {
    expect(decodeLiveEvent(new Uint8Array([255, 255, 255]))).toBeNull();
  });

  it("returns null when a message.created body is malformed", () => {
    const liveEvent = create(LiveEventEnvelopeSchema, {
      eventId: "event-1",
      eventType: "message.created",
      sessionId: "session-1",
      actorId: "actor-1",
      sentAt: BigInt(1000),
      body: new Uint8Array([255, 255, 255]),
    });

    expect(decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, liveEvent))).toBeNull();
  });

  it("returns null when a message.created body decodes without an inner message", () => {
    const liveEvent = create(LiveEventEnvelopeSchema, {
      eventId: "event-2",
      eventType: "message.created",
      sessionId: "session-1",
      actorId: "actor-1",
      sentAt: BigInt(1000),
      body: toBinary(SessionMessageEnvelopeSchema, create(SessionMessageEnvelopeSchema, {})),
    });

    expect(decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, liveEvent))).toBeNull();
  });

  it("decodes acp.event output payloads", () => {
    const acpEvent = create(AcpEventSchema, {
      event: {
        case: "output",
        value: {
          text: "hello",
          isComplete: false,
        },
      },
      model: "gpt-5.2",
    });
    const amuxEnvelope = create(AmuxEnvelopeSchema, {
      runtimeId: "runtime-1",
      actorId: "actor-1",
      sequence: BigInt(7),
      timestamp: BigInt(1_747_642_000),
      payload: {
        case: "acpEvent",
        value: acpEvent,
      },
    });
    const liveEvent = create(LiveEventEnvelopeSchema, {
      eventId: "event-output-1",
      eventType: "acp.event",
      sessionId: "session-1",
      actorId: "actor-agent",
      sentAt: BigInt(1_747_642_000),
      body: toBinary(AmuxEnvelopeSchema, amuxEnvelope),
    });

    const decoded = decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, liveEvent));

    expect(decoded?.acpEvent?.event.case).toBe("output");
    if (decoded?.acpEvent?.event.case === "output") {
      expect(decoded.acpEvent.event.value.text).toBe("hello");
      expect(decoded.acpEvent.event.value.isComplete).toBe(false);
      expect(decoded.acpEvent.model).toBe("gpt-5.2");
    }
  });
});

describe("sessionIdFromTopic", () => {
  it("parses session id from live event topics", () => {
    expect(sessionIdFromTopic("amux/team-1/session/session-1/live")).toBe("session-1");
  });

  it("returns null for non-live topics", () => {
    expect(sessionIdFromTopic("amux/team-1/session/session-1/state")).toBeNull();
  });
});
