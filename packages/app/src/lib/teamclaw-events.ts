import { fromBinary } from "@bufbuild/protobuf";
import {
  LiveEventEnvelopeSchema,
  SessionMessageEnvelopeSchema,
  type LiveEventEnvelope,
  type SessionMessageEnvelope,
  type Message,
} from "@/lib/proto/teamclaw_pb";
import {
  EnvelopeSchema as AmuxEnvelopeSchema,
  type AcpEvent,
  type Envelope as AmuxEnvelope,
} from "@/lib/proto/amux_pb";

export interface DecodedLiveEvent {
  envelope: LiveEventEnvelope;
  sessionMessage?: SessionMessageEnvelope;
  message?: Message;
  // Set when event_type === 'acp.event'
  acpEvent?: AcpEvent;
  amuxEnvelope?: AmuxEnvelope;
}

export function decodeLiveEvent(bytes: Uint8Array): DecodedLiveEvent | null {
  let envelope: LiveEventEnvelope;
  try {
    envelope = fromBinary(LiveEventEnvelopeSchema, bytes);
  } catch {
    return null;
  }

  const decoded: DecodedLiveEvent = { envelope };

  if (envelope.eventType === "message.created" && envelope.body && envelope.body.length > 0) {
    try {
      const sessionMessage = fromBinary(SessionMessageEnvelopeSchema, envelope.body);
      decoded.sessionMessage = sessionMessage;
      decoded.message = sessionMessage.message;
    } catch {
      // ignore body decode failure; envelope still valid for caller inspection
    }
  } else if (envelope.eventType === "acp.event" && envelope.body && envelope.body.length > 0) {
    try {
      const amuxEnv = fromBinary(AmuxEnvelopeSchema, envelope.body);
      decoded.amuxEnvelope = amuxEnv;
      if (amuxEnv.payload?.case === "acpEvent") {
        decoded.acpEvent = amuxEnv.payload.value;
      }
    } catch {
      // ignore body decode failure; envelope still valid for caller inspection
    }
  }

  return decoded;
}

export function streamActorIdFromLiveEvent(decoded: DecodedLiveEvent): string {
  return decoded.envelope.actorId || decoded.amuxEnvelope?.runtimeId || "";
}

export function sessionIdFromLiveEvent(decoded: DecodedLiveEvent, topic: string): string | null {
  return decoded.envelope.sessionId || sessionIdFromTopic(topic);
}

export function sessionIdFromTopic(topic: string): string | null {
  const m = topic.match(/^amux\/[^/]+\/session\/([^/]+)\/live$/);
  if (!m || m[1] === "+") return null;
  return m[1];
}
