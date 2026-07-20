import { create as createMessage } from "@bufbuild/protobuf";
import {
  MessageSchema,
  MessageKind,
  type Message as TeamclawMessage,
} from "@/lib/proto/teamclaw_pb";
import type { MessageRow } from "@/lib/local-cache";

const kindMap: Record<string, MessageKind> = {
  text: MessageKind.TEXT,
  system: MessageKind.SYSTEM,
  agent_thinking: MessageKind.AGENT_THINKING,
  agent_tool_call: MessageKind.AGENT_TOOL_CALL,
  agent_tool_result: MessageKind.AGENT_TOOL_RESULT,
  agent_reply: MessageKind.AGENT_REPLY,
};

export function messageRowsToProto(rows: MessageRow[]): TeamclawMessage[] {
  return rows.map((r) => {
    const proto = createMessage(MessageSchema, {
      messageId: r.id,
      sessionId: r.sessionId,
      senderActorId: r.senderActorId ?? "",
      kind: kindMap[r.kind] ?? MessageKind.TEXT,
      content: r.content ?? "",
      model: r.model ?? "",
      turnId: r.turnId ?? "",
      replyToMessageId: r.replyToMessageId ?? "",
      metadataJson: r.metadataJson ?? "",
      createdAt: BigInt(Math.floor(new Date(r.createdAt).getTime() / 1000)),
    });
    if (r.partsJson) {
      Object.assign(proto, { partsJson: r.partsJson });
    }
    return proto;
  });
}
