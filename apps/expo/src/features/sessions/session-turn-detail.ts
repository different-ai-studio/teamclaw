import { buildThinkingBody } from "./components/agent-thinking-presentation";
import type { SessionMessage } from "./session-types";

export type AgentTurnDetailGroupKind = "thinking" | "tools" | "plan" | "events";

export type AgentTurnDetailGroup = {
  body: string;
  count: number;
  createdAt: string;
  eventIds: string[];
  kind: AgentTurnDetailGroupKind;
  title: string;
};

type MutableGroup = AgentTurnDetailGroup & {
  lines: string[];
};

const THINKING_FALLBACK = "Working…";

function kindKey(message: SessionMessage): string {
  return message.kind.trim().toLowerCase();
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function groupKindFor(message: SessionMessage): AgentTurnDetailGroupKind {
  switch (kindKey(message)) {
    case "agent_thinking":
      return "thinking";
    case "agent_tool_call":
    case "agent_tool_result":
      return "tools";
    case "plan_update":
      return "plan";
    default:
      return "events";
  }
}

function groupTitle(kind: AgentTurnDetailGroupKind): string {
  switch (kind) {
    case "thinking":
      return "Thinking";
    case "tools":
      return "Tools";
    case "plan":
      return "Plan";
    case "events":
    default:
      return "Events";
  }
}

function toolLine(message: SessionMessage): string {
  const body = message.content.trim();
  const metadata = metadataRecord(message.metadata);
  if (kindKey(message) === "agent_tool_call") {
    const toolName = typeof metadata.tool_name === "string" ? metadata.tool_name.trim() : "";
    const prefix = toolName || "Tool call";
    return body ? `${prefix}: ${body}` : prefix;
  }
  return body ? `Tool result: ${body}` : "Tool result";
}

function eventLine(message: SessionMessage): string {
  const body = message.content.trim();
  return body || "Event updated";
}

function textForMessage(message: SessionMessage): string {
  switch (groupKindFor(message)) {
    case "thinking":
      return buildThinkingBody(message.content);
    case "tools":
      return toolLine(message);
    case "plan":
      return message.content.trim() || "Plan updated";
    case "events":
    default:
      return eventLine(message);
  }
}

function compactThinkingText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([.!?。！？])(?=\S)/gu, "$1 ");
}

function thinkingBody(lines: readonly string[]): string {
  const chunks = lines.filter((line) => line !== THINKING_FALLBACK);
  if (chunks.length === 0) return THINKING_FALLBACK;
  return compactThinkingText(chunks.join("")) || THINKING_FALLBACK;
}

export function buildAgentTurnDetailGroups(
  events: readonly SessionMessage[],
): AgentTurnDetailGroup[] {
  const groups = new Map<AgentTurnDetailGroupKind, MutableGroup>();
  const orderedKinds: AgentTurnDetailGroupKind[] = [];

  for (const event of events) {
    const kind = groupKindFor(event);
    let group = groups.get(kind);
    if (!group) {
      group = {
        body: "",
        count: 0,
        createdAt: event.createdAt,
        eventIds: [],
        kind,
        lines: [],
        title: groupTitle(kind),
      };
      groups.set(kind, group);
      orderedKinds.push(kind);
    }

    group.count += 1;
    group.eventIds.push(event.messageId);

    if (kind === "thinking") {
      const body = buildThinkingBody(event.content);
      const isPlaceholder = body === THINKING_FALLBACK;
      const hasRealChunk = group.lines.some((line) => line !== THINKING_FALLBACK);
      if (isPlaceholder && !hasRealChunk) {
        if (group.lines.length === 0) {
          group.lines.push(THINKING_FALLBACK);
        }
      } else {
        if (group.lines.length === 1 && group.lines[0] === THINKING_FALLBACK) {
          group.lines = [];
        }
        group.lines.push(event.content);
      }
      continue;
    }

    const line = textForMessage(event);
    if (kind === "plan") {
      group.lines = [line];
    } else {
      group.lines.push(line);
    }
  }

  return orderedKinds.map((kind) => {
    const group = groups.get(kind)!;
    const body =
      group.kind === "thinking"
        ? thinkingBody(group.lines)
        : group.lines.join("\n\n").trim();
    return {
      body,
      count: group.count,
      createdAt: group.createdAt,
      eventIds: group.eventIds,
      kind: group.kind,
      title: group.title,
    };
  });
}
