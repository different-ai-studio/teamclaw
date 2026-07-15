import { fromBinary } from "@bufbuild/protobuf";
import {
  LiveEventEnvelopeSchema,
  SessionMessageEnvelopeSchema,
  type LiveEventEnvelope,
  type SessionMessageEnvelope,
  type Message,
} from "@teamclaw/app/proto/teamclaw_pb";
import {
  EnvelopeSchema as AmuxEnvelopeSchema,
  type AcpEvent,
} from "@teamclaw/app/proto/amux_pb";

export interface DecodedLiveEvent {
  envelope: LiveEventEnvelope;
  sessionMessage?: SessionMessageEnvelope;
  message?: Message;
  acpEvent?: AcpEvent;
}

export function decodeLiveEvent(bytes: Uint8Array): DecodedLiveEvent | null {
  let envelope: LiveEventEnvelope;

  try {
    envelope = fromBinary(LiveEventEnvelopeSchema, bytes);
  } catch {
    return null;
  }

  const decoded: DecodedLiveEvent = { envelope };

  if (envelope.eventType === "message.created") {
    if (!envelope.body) {
      return null;
    }
    try {
      const sessionMessage = fromBinary(SessionMessageEnvelopeSchema, envelope.body);
      if (!sessionMessage.message) {
        return null;
      }
      decoded.sessionMessage = sessionMessage;
      decoded.message = sessionMessage.message;
    } catch {
      return null;
    }
  } else if (envelope.eventType === "acp.event" && envelope.body && envelope.body.length > 0) {
    try {
      const amuxEnvelope = fromBinary(AmuxEnvelopeSchema, envelope.body);
      if (amuxEnvelope.payload.case === "acpEvent") {
        decoded.acpEvent = amuxEnvelope.payload.value;
      }
    } catch {
      return null;
    }
  }

  return decoded;
}

export function sessionIdFromTopic(topic: string): string | null {
  const match = topic.match(/^amux\/[^/]+\/session\/([^/]+)\/live$/);
  return match ? match[1] : null;
}
