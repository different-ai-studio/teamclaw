// v2 → SDK message-shape adapter. The legacy MessageList expects the
// OpenCode SDK Message shape (id, role, parts[], toolCalls, timestamp,
// etc). v2 stores Teamclaw_Message (proto) in `useSessionStore.messages`.
// This wraps each proto into the legacy shape so MessageList renders
// unchanged. Phase 2 will replace MessageList with an actor-native
// renderer and this adapter goes away.

import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import { MessageKind } from "@/lib/proto/teamclaw_pb";
import type { Message as SdkMessage } from "@/stores/session-types";

function kindToRole(kind: MessageKind): SdkMessage["role"] {
  switch (kind) {
    case MessageKind.SYSTEM:
      return "system";
    case MessageKind.AGENT_THINKING:
    case MessageKind.AGENT_TOOL_CALL:
    case MessageKind.AGENT_TOOL_RESULT:
    case MessageKind.AGENT_REPLY:
      return "assistant";
    case MessageKind.TEXT:
    default:
      return "user";
  }
}

export function adaptTeamclawMessageToSdk(m: TeamclawMessage): SdkMessage {
  return {
    id: m.messageId,
    sessionId: m.sessionId,
    senderActorId: m.senderActorId,
    role: kindToRole(m.kind),
    content: m.content,
    parts: [
      {
        id: `${m.messageId}-p0`,
        type: "text",
        text: m.content,
        content: m.content,
      },
    ],
    toolCalls: [],
    timestamp: new Date(Number(m.createdAt) * 1000),
  };
}

export function adaptTeamclawMessages(
  msgs: TeamclawMessage[] | undefined,
): SdkMessage[] | undefined {
  if (!msgs) return undefined;
  return msgs.map(adaptTeamclawMessageToSdk);
}
