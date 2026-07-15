import type { Message as SdkMessage, MessagePart, ToolCall } from "@/stores/session-types";
import type { OpenCodeMessage } from "./types";

function toolCallStatusToOpenCode(status: ToolCall["status"]): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "waiting":
      return "pending";
    case "calling":
    default:
      return "running";
  }
}

function partToOpenCode(part: MessagePart): Record<string, unknown> | null {
  if (part.type === "reasoning") {
    const text = part.text || part.content || "";
    if (!text) return null;
    return { type: "reasoning", text };
  }
  if (part.type === "text") {
    const text = part.text || part.content || "";
    if (!text) return null;
    return { type: "text", text };
  }
  if (part.type === "tool-call" && part.toolCall) {
    const toolCall = part.toolCall;
    return {
      type: "tool",
      tool: toolCall.name,
      state: {
        status: toolCallStatusToOpenCode(toolCall.status),
        input: toolCall.arguments,
        output: toolCall.result ?? toolCall.rawOutput,
      },
    };
  }
  return null;
}

export function sdkMessageToOpenCode(msg: SdkMessage): OpenCodeMessage {
  const info: Record<string, unknown> = {
    id: msg.id,
    sessionID: msg.sessionId,
    role: msg.role,
    time: { created: msg.timestamp.getTime() },
  };
  if (msg.modelID) info.modelID = msg.modelID;
  if (msg.providerID) info.providerID = msg.providerID;
  if (msg.agent) info.agent = msg.agent;
  if (msg.senderActorId) info.senderActorId = msg.senderActorId;

  const parts = msg.parts
    .map(partToOpenCode)
    .filter((part): part is Record<string, unknown> => part !== null);

  return { info, parts };
}
