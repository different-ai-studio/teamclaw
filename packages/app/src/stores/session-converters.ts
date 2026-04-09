import type {
  Session as OpenCodeSession,
  SessionListItem,
  Message as OpenCodeMessage,
} from "@/lib/opencode/sdk-types";
import type { ToolCall, MessagePart, Message, Session } from './session-types';

// Convert OpenCode message to our format
export function convertMessage(msg: OpenCodeMessage): Message {
  const content = msg.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("");

  // Extract tool calls and pair them with results
  const toolParts = msg.parts.filter(
    (p) => p.type === "tool-call" || p.type === "tool",
  );
  const toolResultParts = msg.parts.filter((p) => p.type === "tool-result");

  const toolCalls: ToolCall[] = toolParts.map((p) => {
    // For 'tool' type parts, get result and metadata from state
    // For 'tool-call' type parts, find matching result from toolResultParts
    const state = p.state as
      | {
          status?: string;
          output?: string;
          metadata?: Record<string, unknown>;
          input?: Record<string, unknown>;
        }
      | undefined;

    let toolResult: unknown;
    let toolMetadata: ToolCall["metadata"] | undefined;

    if (p.type === "tool" && state) {
      // For 'tool' type, result may be in raw, output, or result (OpenCode variance)
      const s = state as { raw?: unknown; output?: unknown; result?: unknown };
      toolResult = s.raw ?? s.output ?? s.result;
      // metadata is in state.metadata (for task tool: sessionId, summary, etc.)
      if (state.metadata) {
        const meta = state.metadata as Record<string, unknown>;
        toolMetadata = {
          sessionId: meta.sessionId as string | undefined,
          model: meta.model as
            | { providerID: string; modelID: string }
            | undefined,
          summary: meta.summary as
            | Array<{
                id: string;
                tool: string;
                state: { status: string; title?: string };
              }>
            | undefined,
          title: meta.title as string | undefined,
        };
      }
    } else {
      // For 'tool-call' type, find matching result
      const matchingResult = toolResultParts.find((r) => r.toolResult?.content);
      toolResult = matchingResult?.toolResult?.content;
    }

    // Determine status based on available info
    let status: "calling" | "completed" | "failed" | "waiting" = "completed";
    if (p.type === "tool" && state?.status === "pending") {
      status = "calling";
    } else if (p.type === "tool" && state?.status === "running") {
      status = "calling";
    } else if (p.type === "tool" && state?.status === "error") {
      status = "failed";
    } else if (p.time?.end === undefined && p.time?.start !== undefined) {
      status = "calling";
    }

    // Handle both 'tool' type (from SSE) and 'tool-call' type
    const toolName = p.toolCall?.name || p.tool || "unknown";
    const toolId = p.toolCall?.id || p.callID || p.id;
    const toolInput = p.toolCall?.input || state?.input || {};

    return {
      id: toolId,
      name: toolName,
      status,
      arguments: toolInput,
      result: toolResult,
      startTime: new Date(p.time?.start || msg.info.time.created),
      duration:
        p.time?.end && p.time?.start ? p.time.end - p.time.start : undefined,
      metadata: toolMetadata,
    };
  });

  const parts: MessagePart[] = msg.parts.map((p) => ({
    id: p.id,
    type: p.type,
    content: p.text,
    text: p.text, // Keep text field for reasoning
    tool: p.toolCall,
    result: p.toolResult,
  }));

  return {
    id: msg.info.id,
    sessionId: msg.info.sessionID,
    role: msg.info.role,
    content,
    parts,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    timestamp: new Date(msg.info.time.created),
    tokens: msg.info.tokens,
    cost: msg.info.cost,
    // Preserve model information from OpenCode
    modelID: msg.info.modelID,
    providerID: msg.info.providerID,
    agent: msg.info.agent,
  };
}

// Convert OpenCode session to our format
export function convertSession(session: OpenCodeSession): Session {
  return {
    id: session.id,
    title: session.title || "New Chat",
    messages: [],
    createdAt: new Date(session.time.created),
    updatedAt: new Date(session.time.updated),
    directory: session.directory,
    parentID: session.parentID,
  };
}

// Convert session list item
export function convertSessionListItem(item: SessionListItem): Session {
  return {
    id: item.id,
    title: item.title || "New Chat",
    messages: [],
    createdAt: new Date(item.time.created),
    updatedAt: new Date(item.time.updated),
    directory: item.directory,
    parentID: item.parentID,
  };
}
