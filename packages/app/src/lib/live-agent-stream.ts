import { create as createMessage } from "@bufbuild/protobuf";
import { AgentStatus } from "@/lib/proto/amux_pb";
import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclaw_pb";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import type { ToolCallContentBlock } from "@/components/chat/tool-calls/tool-call-content";
import { parseToolContentBlocks } from "@/components/chat/tool-calls/tool-call-content";
import { deriveAgentReplyContent } from "@/lib/agent-reply-transcript";
import { agentReplyTextsEquivalent } from "@/lib/agent-reply-text";

export {
  deriveAgentReplyContent,
  joinTextPartsFromParts,
} from "@/lib/agent-reply-transcript";

export function agentStreamKey(sessionId: string, actorId: string): string {
  return `${sessionId}::${actorId}`;
}

let discardPendingStreamReplyHandler:
  | ((sessionId: string, actorId: string) => void)
  | null = null;

/** App registers a handler to drop parked AGENT_REPLY rows without persisting. */
export function registerDiscardPendingStreamReply(
  handler: ((sessionId: string, actorId: string) => void) | null,
): void {
  discardPendingStreamReplyHandler = handler;
}

export function discardPendingStreamReply(sessionId: string, actorId: string): void {
  discardPendingStreamReplyHandler?.(sessionId, actorId);
}

const SEEN_LIVE_EVENT_IDS_CAP = 2_000;

/** Dedupe MQTT live envelopes that may be redelivered with the same eventId. */
export function rememberLiveEventId(
  seen: Set<string>,
  sessionId: string,
  eventId: string | undefined,
): boolean {
  if (!eventId) return true;
  const key = `${sessionId}::${eventId}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_LIVE_EVENT_IDS_CAP) {
    const oldest = seen.values().next().value;
    if (oldest) seen.delete(oldest);
  }
  return true;
}

/** Join mid-turn daemon AgentReply slices without duplicating overlapping text. */
export function joinDistinctPendingReplyChunks(pending: TeamclawMessage[]): string {
  const chunks: string[] = [];
  for (const message of pending) {
    const text = message.content?.trim();
    if (!text) continue;
    const previous = chunks[chunks.length - 1];
    if (!previous) {
      chunks.push(text);
      continue;
    }
    if (text === previous || agentReplyTextsEquivalent(text, previous)) continue;
    if (previous.includes(text) || agentReplyTextsEquivalent(previous, text)) continue;
    if (text.includes(previous)) {
      chunks[chunks.length - 1] = text;
      continue;
    }
    chunks.push(text);
  }
  return chunks.join("\n\n");
}

/**
 * Pick the persisted AGENT_REPLY row from parked daemon slices.
 * Body text comes from the live transcript (parts[]), not from merge heuristics.
 */
export function mergePendingAgentReplies(
  pending: TeamclawMessage[],
  streamEntry?: StreamVisibilityEntry,
): TeamclawMessage | null {
  if (pending.length === 0) return null;
  const last = pending[pending.length - 1];
  const content = deriveAgentReplyContent(streamEntry?.parts ?? [], pending);
  if (!content.trim() && !streamEntryHasVisibleContent(streamEntry)) return null;
  return { ...last, content };
}

/** Client-side anchor when daemon terminal arrives before agent_reply (interrupt + tool). */
export function buildInterruptedStreamAnchor(
  sessionId: string,
  actorId: string,
  snapshot: AgentStreamEntry,
): TeamclawMessage {
  const createdAtMs =
    snapshot.toolCalls[0]?.startTime?.getTime?.() ??
    snapshot.lastUpdate ??
    Date.now();
  return createMessage(MessageSchema, {
    messageId: `interrupt-${snapshot.streamId}`,
    sessionId,
    senderActorId: actorId,
    kind: MessageKind.AGENT_REPLY,
    content: "",
    turnId: `interrupt-${snapshot.streamId}`,
    createdAt: BigInt(Math.max(1, Math.floor(createdAtMs / 1000))),
  });
}

/** Daemon emits an empty AGENT_REPLY anchor when a tool-only turn ends (e.g. cancel). */
export function isToolOnlyTurnAnchor(
  pending: TeamclawMessage[],
  streamEntry?: StreamVisibilityEntry,
): boolean {
  const merged = mergePendingAgentReplies(pending, streamEntry);
  if (!merged) return false;
  return !merged.content.trim() && streamEntryHasVisibleContent(streamEntry);
}

type StreamVisibilityEntry = {
  outputText?: string;
  thinkingText?: string;
  toolCalls?: Array<unknown>;
  parts?: Array<{
    type?: string;
    text?: string;
    content?: string;
    toolCall?: unknown;
  }>;
  pendingPermissionsByRequestId?: Record<string, unknown>;
};

export function streamEntryHasVisibleContent(
  entry: StreamVisibilityEntry | undefined,
): boolean {
  if (!entry) return false;
  if (entry.outputText?.trim()) return true;
  if (entry.thinkingText?.trim()) return true;
  if (Object.keys(entry.pendingPermissionsByRequestId ?? {}).length > 0) return true;
  if ((entry.toolCalls?.length ?? 0) > 0) return true;
  return (entry.parts ?? []).some((part) => {
    if (part.type === "tool-call") return Boolean(part.toolCall);
    return Boolean(part.text?.trim() || part.content?.trim());
  });
}

/** Text/thinking transcript only — excludes tool calls and permission metadata. */
export function streamTranscriptHasText(
  entry: StreamVisibilityEntry | undefined,
): boolean {
  if (!entry) return false;
  if (entry.outputText?.trim()) return true;
  if (entry.thinkingText?.trim()) return true;
  return (entry.parts ?? []).some((part) => {
    if (part.type === "tool-call") return false;
    return Boolean(part.text?.trim() || part.content?.trim());
  });
}

function textPartRevision(part: {
  type?: string;
  text?: string;
  content?: string;
}): string {
  const text = part.text ?? part.content ?? "";
  return `${part.type ?? "part"}:${text.length}:${text.slice(-48)}`;
}

/** Transcript-only revision for pause loading — ignores tool status / permission metadata. */
export function streamTranscriptRevision(entry: StreamVisibilityEntry): string {
  const partSigs = (entry.parts ?? [])
    .filter((part) => part.type !== "tool-call")
    .map((part) => textPartRevision(part));
  const out = entry.outputText ?? "";
  const think = entry.thinkingText ?? "";
  return [
    `out:${out.length}:${out.slice(-48)}`,
    `think:${think.length}:${think.slice(-48)}`,
    ...partSigs,
  ].join("\0");
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function paramsField(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
    else if (raw !== undefined && raw !== null) out[key] = String(raw);
  }
  return out;
}

function parseJsonObject(value: string): Record<string, string> {
  if (!value.trim().startsWith("{")) return {};
  try {
    return paramsField(JSON.parse(value));
  } catch {
    return {};
  }
}

function recordFromValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function parseJsonValue(value: string): unknown {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseWireLocations(raw: Record<string, unknown>): Array<{ path: string; line?: number }> | undefined {
  const items = Array.isArray(raw.locations) ? raw.locations : [];
  const out: Array<{ path: string; line?: number }> = [];
  for (const item of items) {
    const loc = recordFromValue(item);
    const path = String(loc.path ?? "");
    if (!path) continue;
    const line = typeof loc.line === "number" ? loc.line : undefined;
    out.push(line !== undefined ? { path, line } : { path });
  }
  return out.length > 0 ? out : undefined;
}

export function normalizeToolUseEvent(value: unknown): {
  toolId: string;
  toolName: string;
  description: string;
  params: Record<string, string>;
  toolKind?: string;
  content?: ToolCallContentBlock[];
  locations?: Array<{ path: string; line?: number }>;
  acpStatus?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
} {
  const raw = recordFromValue(value);
  const description = stringField(raw, "description");
  const wireParams = paramsField(raw.params);
  const params =
    Object.keys(wireParams).length > 0
      ? wireParams
      : { ...parseJsonObject(description), ...wireParams };
  const toolKind = stringField(raw, "toolKind", "tool_kind");
  const explicitToolName = stringField(raw, "toolName", "tool_name");
  const rawInputJson = stringField(raw, "rawInputJson", "raw_input_json");
  const rawOutputJson = stringField(raw, "rawOutputJson", "raw_output_json");
  const acpStatus = stringField(raw, "status", "acpStatus");
  const content = Array.isArray(raw.content) ? parseToolContentBlocks(raw) : undefined;
  const locations = parseWireLocations(raw);
  return {
    toolId: stringField(raw, "toolId", "tool_id"),
    toolName: explicitToolName || "unknown",
    description,
    params,
    toolKind: toolKind || undefined,
    content,
    locations,
    acpStatus: acpStatus || undefined,
    rawInput: parseJsonValue(rawInputJson),
    rawOutput: parseJsonValue(rawOutputJson),
  };
}

export function normalizeToolResultEvent(value: unknown): {
  toolId: string;
  success: boolean;
  summary: string;
  content?: ToolCallContentBlock[];
  rawOutput?: unknown;
} {
  const raw = recordFromValue(value);
  const success = raw.success === true || raw.success === "true";
  const rawOutputJson = stringField(raw, "rawOutputJson", "raw_output_json");
  const content = Array.isArray(raw.content) ? parseToolContentBlocks(raw) : undefined;
  return {
    toolId: stringField(raw, "toolId", "tool_id"),
    success,
    summary: stringField(raw, "summary"),
    content,
    rawOutput: parseJsonValue(rawOutputJson),
  };
}

export function isTerminalAgentStatus(status: AgentStatus | number | undefined): boolean {
  return (
    status === AgentStatus.IDLE ||
    status === AgentStatus.ERROR ||
    status === AgentStatus.STOPPED
  );
}

/** Daemon emits `statusChange` with `newStatus=ACTIVE` when a prompt turn starts. */
export function isAgentActiveStatus(status: AgentStatus | number | undefined): boolean {
  return status === AgentStatus.ACTIVE;
}
