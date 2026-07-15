// v2 → SDK message-shape adapter. The legacy MessageList expects the
// OpenCode SDK Message shape (id, role, parts[], toolCalls, timestamp,
// etc). v2 stores Teamclaw_Message (proto) in `useSessionStore.messages`.
//
// In addition to shape adaptation, this module groups consecutive
// same-turn agent messages into ONE SdkMessage so that the daemon's
// per-ACP-block firehose (one thinking row, one tool_call row, one
// tool_result row, one or more agent_reply rows — all sharing a
// turn_id) renders as a single coherent agent bubble.

import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import { MessageKind } from "@/lib/proto/teamclaw_pb";
import type {
  Message as SdkMessage,
  MessagePart,
  ToolCall,
} from "@/stores/session-types";
import { parseToolContentBlocks } from "@/components/chat/tool-calls/tool-call-content";

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

/** 1:1 mapping (legacy path) for messages without a turn_id or for
 * non-assistant roles. */
function parseMentionDeliverySnapshot(
  m: TeamclawMessage,
): SdkMessage["mentionDeliverySnapshot"] {
  const md = parseMetadata(m);
  const raw = md.mention_delivery_snapshot;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: NonNullable<SdkMessage["mentionDeliverySnapshot"]> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (v === "ready" || v === "offline" || v === "stale") out[id] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function adaptTeamclawMessageToSdk(m: TeamclawMessage): SdkMessage {
  const mentionActorIds = parseDisplayMentionActorIds(m);
  const mentionDeliverySnapshot = parseMentionDeliverySnapshot(m);
  return {
    id: m.messageId,
    sessionId: m.sessionId,
    senderActorId: m.senderActorId,
    role: kindToRole(m.kind),
    content: m.content,
    mentionActorIds,
    mentionDeliverySnapshot,
    modelID: m.model || undefined,
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

function parseMetadata(m: TeamclawMessage): Record<string, unknown> {
  try {
    return m.metadataJson ? (JSON.parse(m.metadataJson) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseDisplayMentionActorIds(m: TeamclawMessage): string[] {
  const md = parseMetadata(m);
  const raw = md.display_mention_actor_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function partsJson(m: TeamclawMessage): string {
  return (m as unknown as { partsJson?: string | null }).partsJson ?? "";
}

function reviveToolCallDates(toolCall: ToolCall): ToolCall {
  const rawStartTime = toolCall.startTime as unknown;
  return {
    ...toolCall,
    startTime:
      rawStartTime instanceof Date
        ? rawStartTime
        : typeof rawStartTime === "string" || typeof rawStartTime === "number"
          ? new Date(rawStartTime)
          : new Date(),
  };
}

function parsePartsJson(json: string): MessagePart[] {
  try {
    const parsed = JSON.parse(json) as MessagePart[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((part) => part && typeof part === "object" && typeof part.type === "string")
      .map((part) =>
        part.type === "tool-call" && part.toolCall
          ? { ...part, toolCall: reviveToolCallDates(part.toolCall) }
          : part,
      );
  } catch {
    return [];
  }
}

function partText(part: MessagePart): string {
  return (part.text || part.content || "").trim();
}

/** Merge ordered per-reply parts_json slices from the same turn (reload path). */
function mergeTurnPartsFromReplies(replies: TeamclawMessage[]): MessagePart[] {
  const sorted = [...replies].sort(compareTeamclawMessages);
  const out: MessagePart[] = [];
  const toolIndexById = new Map<string, number>();

  for (const reply of sorted) {
    const json = partsJson(reply);
    if (!json.trim()) continue;
    for (const part of parsePartsJson(json)) {
      if (part.type === "tool-call" && part.toolCall) {
        const toolId = part.toolCall.id;
        const existingIndex = toolIndexById.get(toolId);
        if (existingIndex !== undefined) {
          out[existingIndex] = part;
          continue;
        }
        toolIndexById.set(toolId, out.length);
        out.push(part);
        continue;
      }
      if (part.type === "reasoning") {
        const text = partText(part);
        if (!text) continue;
        const last = out[out.length - 1];
        if (last?.type === "reasoning") {
          const merged = `${partText(last)}\n\n${text}`.trim();
          out[out.length - 1] = { ...last, text: merged, content: merged };
        } else {
          out.push(part);
        }
        continue;
      }
      if (part.type === "text") {
        const text = partText(part);
        if (!text) continue;
        const last = out[out.length - 1];
        if (last?.type === "text" && partText(last) === text) continue;
        out.push(part);
      }
    }
  }

  return out;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseMetadataLocations(value: unknown): Array<{ path: string; line?: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ path: string; line?: number }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const loc = item as Record<string, unknown>;
    const path = String(loc.path ?? "");
    if (!path) continue;
    const line = typeof loc.line === "number" ? loc.line : undefined;
    out.push({ path, line });
  }
  return out.length > 0 ? out : undefined;
}

function parseMetadataContent(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return parseToolContentBlocks(value);
}

function paramsFromDescription(description: string): Record<string, unknown> {
  if (!description) return {};
  if (!description.trim().startsWith("{")) {
    return { _description: description };
  }
  try {
    const parsed = JSON.parse(description) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { _description: description };
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    );
  } catch {
    return { _description: description };
  }
}

function paramsFromMetadataParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, raw]) => [
      key,
      typeof raw === "string" ? raw : JSON.stringify(raw),
    ]),
  );
}

function optionalOrder(m: TeamclawMessage): bigint | null {
  const maybe = m as unknown as {
    sequence?: bigint | number | string;
    order?: bigint | number | string;
    orderIndex?: bigint | number | string;
  };
  const raw = maybe.sequence ?? maybe.order ?? maybe.orderIndex;
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function compareBigInt(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareTeamclawMessages(a: TeamclawMessage, b: TeamclawMessage): number {
  const aOrder = optionalOrder(a);
  const bOrder = optionalOrder(b);
  if (aOrder !== null && bOrder !== null && aOrder !== bOrder) {
    return compareBigInt(aOrder, bOrder);
  }
  if (aOrder !== null && bOrder === null) return -1;
  if (aOrder === null && bOrder !== null) return 1;

  const created = compareBigInt(a.createdAt, b.createdAt);
  if (created !== 0) return created;

  return a.messageId.localeCompare(b.messageId);
}

/** Collapse a run of consecutive same-(senderActorId, turnId) assistant
 * messages into one SdkMessage. Thinking → reasoning part. Tool calls →
 * toolCalls[] matched with results by metadata.tool_id. Replies →
 * concatenated content. */
function buildTurnSdkMessage(group: TeamclawMessage[]): SdkMessage {
  const thinking = group.filter((m) => m.kind === MessageKind.AGENT_THINKING);
  const toolCallProtos = group.filter((m) => m.kind === MessageKind.AGENT_TOOL_CALL);
  const toolResultProtos = group.filter((m) => m.kind === MessageKind.AGENT_TOOL_RESULT);
  const replies = group.filter((m) => m.kind === MessageKind.AGENT_REPLY);

  const resultByToolId = new Map<
    string,
    {
      success: boolean;
      summary: string;
      content?: ReturnType<typeof parseToolContentBlocks>;
      rawOutput?: unknown;
    }
  >();
  for (const r of toolResultProtos) {
    const md = parseMetadata(r);
    const toolId = String(md.tool_id ?? "");
    if (toolId) {
      resultByToolId.set(toolId, {
        success: Boolean(md.success),
        summary: r.content,
        content: parseMetadataContent(md.content),
        rawOutput: parseJsonValue(md.raw_output_json),
      });
    }
  }

  const toolCalls: ToolCall[] = toolCallProtos.map((tc) => {
    const md = parseMetadata(tc);
    const toolId = String(md.tool_id ?? "");
    const toolNameRaw = String(md.tool_name ?? "unknown");
    const toolKind =
      typeof md.tool_kind === "string"
        ? md.tool_kind
        : typeof md.toolKind === "string"
          ? md.toolKind
          : undefined;
    const description = String(md.description ?? "");
    const args = {
      ...paramsFromDescription(description),
      ...paramsFromMetadataParams(md.params),
    };
    const match = toolId ? resultByToolId.get(toolId) : undefined;
    const acpStatus =
      typeof md.status === "string" && md.status.trim() ? md.status : undefined;
    const toolUseContent = parseMetadataContent(md.content);
    return {
      id: toolId || tc.messageId,
      name: toolNameRaw,
      toolKind,
      acpStatus,
      content: match?.content ?? toolUseContent,
      locations: parseMetadataLocations(md.locations),
      rawInput: parseJsonValue(md.raw_input_json),
      status: match ? (match.success ? "completed" : "failed") : "calling",
      arguments: args,
      startTime: new Date(Number(tc.createdAt) * 1000),
      result: match ? match.summary : undefined,
      ...(match?.rawOutput !== undefined ? { rawOutput: match.rawOutput } : {}),
    };
  });
  const toolCallByMessageId = new Map<string, ToolCall>();
  toolCallProtos.forEach((proto, index) => {
    const toolCall = toolCalls[index];
    if (!toolCall) return;
    toolCallByMessageId.set(proto.messageId, toolCall);
  });

  // Legacy desktop builds wrote live-cache rows before Supabase generated a
  // different id for the same reply. Collapse those exact same-turn echoes.
  const uniqueReplies: TeamclawMessage[] = [];
  const uniqueReplyIds = new Set<string>();
  const replyIndexByKey = new Map<string, number>();
  for (const reply of replies) {
    const key = `${reply.content}\u0000${reply.model}`;
    const existingIndex = replyIndexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = uniqueReplies[existingIndex];
      if (!partsJson(existing) && partsJson(reply)) {
        uniqueReplyIds.delete(existing.messageId);
        uniqueReplies[existingIndex] = reply;
        uniqueReplyIds.add(reply.messageId);
      }
      continue;
    }
    replyIndexByKey.set(key, uniqueReplies.length);
    uniqueReplies.push(reply);
    uniqueReplyIds.add(reply.messageId);
  }
  const replyText = uniqueReplies.map((r) => r.content).join("\n\n");
  const thinkingText = thinking.map((t) => t.content).join("\n");

  const groupId = uniqueReplies[0]?.messageId ?? group[0].messageId;
  const repliesWithParts = uniqueReplies.filter((reply) => partsJson(reply).trim());
  const mergedPersistedParts =
    repliesWithParts.length > 1
      ? mergeTurnPartsFromReplies(repliesWithParts)
      : repliesWithParts.length === 1
        ? parsePartsJson(partsJson(repliesWithParts[0]!))
        : [];

  if (mergedPersistedParts.length > 0) {
    const canonicalReply = uniqueReplies[uniqueReplies.length - 1]!;
    const canonicalToolCalls = mergedPersistedParts
      .filter((part) => part.type === "tool-call" && part.toolCall)
      .map((part) => part.toolCall!);
    const canonicalModelID =
      canonicalReply.model ||
      uniqueReplies[uniqueReplies.length - 1]?.model ||
      group.find((m) => m.model)?.model ||
      undefined;
    return {
      id: canonicalReply.messageId,
      sessionId: canonicalReply.sessionId,
      senderActorId: canonicalReply.senderActorId,
      role: "assistant",
      content: replyText,
      modelID: canonicalModelID,
      parts: mergedPersistedParts,
      toolCalls: canonicalToolCalls,
      timestamp: new Date(Number(group[0].createdAt) * 1000),
    };
  }

  const canonicalReply = [...uniqueReplies].reverse().find((reply) => partsJson(reply));
  if (canonicalReply) {
    const canonicalParts = parsePartsJson(partsJson(canonicalReply));
    if (canonicalParts.length > 0) {
      const canonicalToolCalls = canonicalParts
        .filter((part) => part.type === "tool-call" && part.toolCall)
        .map((part) => part.toolCall!);
      const canonicalText = canonicalParts
        .filter((part) => part.type === "text")
        .map((part) => part.text || part.content || "")
        .filter(Boolean)
        .join("\n\n");
      const canonicalModelID =
        canonicalReply.model ||
        uniqueReplies[uniqueReplies.length - 1]?.model ||
        group.find((m) => m.model)?.model ||
        undefined;
      return {
        id: canonicalReply.messageId,
        sessionId: canonicalReply.sessionId,
        senderActorId: canonicalReply.senderActorId,
        role: "assistant",
        content: canonicalText || canonicalReply.content || replyText,
        modelID: canonicalModelID,
        parts: canonicalParts,
        toolCalls: canonicalToolCalls,
        timestamp: new Date(Number(group[0].createdAt) * 1000),
      };
    }
  }

  const parts: MessagePart[] = [];
  if (thinkingText) {
    parts.push({
      id: `${groupId}-r0`,
      type: "reasoning",
      text: thinkingText,
      content: thinkingText,
    });
  }
  if (toolCalls.length > 0) {
    let textPartIndex = 0;
    for (const item of group) {
      if (item.kind === MessageKind.AGENT_REPLY && uniqueReplyIds.has(item.messageId)) {
        if (!item.content) continue;
        parts.push({
          id: `${item.messageId}-p${textPartIndex++}`,
          type: "text",
          text: item.content,
          content: item.content,
        });
      } else if (item.kind === MessageKind.AGENT_TOOL_CALL) {
        const toolCall = toolCallByMessageId.get(item.messageId);
        if (!toolCall) continue;
        parts.push({
          id: `${item.messageId}-tool`,
          type: "tool-call",
          toolCallId: toolCall.id,
          toolCall,
        });
      }
    }
  } else {
    parts.push({
      id: `${groupId}-p0`,
      type: "text",
      text: replyText,
      content: replyText,
    });
  }

  // model: prefer last reply (most recent decision), fall back to any
  // message that carries one.
  const modelID =
    uniqueReplies[uniqueReplies.length - 1]?.model ||
    group.find((m) => m.model)?.model ||
    undefined;

  return {
    id: groupId,
    sessionId: group[0].sessionId,
    senderActorId: group[0].senderActorId,
    role: "assistant",
    content: replyText,
    modelID,
    parts,
    toolCalls,
    timestamp: new Date(Number(group[0].createdAt) * 1000),
  };
}

function groupByTurn(msgs: TeamclawMessage[]): SdkMessage[] {
  const out: SdkMessage[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    // Pass-through if no turnId (legacy / non-agent / user / system).
    if (!m.turnId || kindToRole(m.kind) !== "assistant") {
      out.push(adaptTeamclawMessageToSdk(m));
      i++;
      continue;
    }
    const turnId = m.turnId;
    const senderId = m.senderActorId;
    const group: TeamclawMessage[] = [];
    while (
      i < msgs.length &&
      msgs[i].turnId === turnId &&
      msgs[i].senderActorId === senderId
    ) {
      group.push(msgs[i]);
      i++;
    }
    out.push(buildTurnSdkMessage(group));
  }
  return out;
}

export function adaptTeamclawMessages(
  msgs: TeamclawMessage[] | undefined,
): SdkMessage[] | undefined {
  if (!msgs) return undefined;
  // Sort defensively — caller should already merge in createdAt order,
  // but local cache + supabase merge can interleave at the same epoch.
  const sorted = [...msgs].sort(compareTeamclawMessages);
  return groupByTurn(sorted);
}
