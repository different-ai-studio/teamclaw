// Persist ordered runtime parts from the in-memory streaming entry onto the
// final AGENT_REPLY row. The daemon persists reply text to Supabase, while
// thinking/tool events are live-only; `parts_json` lets reload restore the
// same text/tool ordering without reconstructing it from synthetic rows.

import {
  deriveAgentReplyContent,
  joinTextPartsFromParts,
} from "@/lib/agent-reply-transcript";
import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import type { MessagePart } from "@/stores/session-types";
import {
  type AgentStreamEntry,
  useV2StreamingStore,
} from "@/stores/v2-streaming-store";
import { enrichMessageParts, setMessageParts } from "@/lib/local-cache";
import { useWorkspaceStore } from "@/stores/workspace";
import { snapshotSubagentEntry } from "@/lib/subagent-snapshot";
import { extractTaskChildBinding, isTaskToolCall } from "@/lib/teamclaw/subagent-acp-binding";

/** Snapshot live transcript parts — the only canonical source for parts_json. */
export function snapshotTranscriptParts(
  entry: AgentStreamEntry | undefined,
): MessagePart[] {
  if (!entry) return [];
  return entry.parts.filter(
    (part) =>
      (part.type === "reasoning" && Boolean(part.text || part.content)) ||
      (part.type === "text" && Boolean(part.text || part.content)) ||
      (part.type === "tool-call" && Boolean(part.toolCall)),
  );
}

/** Attach nested subagent snapshots onto task tool-call parts before persist. */
export function mergeSubagentSnapshotsIntoParts(
  parts: MessagePart[],
  _sessionId: string,
  _actorId: string,
): MessagePart[] {
  const state = useV2StreamingStore.getState();
  return parts.map((part) => {
    if (part.type !== "tool-call" || !part.toolCall || !isTaskToolCall(part.toolCall)) {
      return part;
    }
    const toolId = part.toolCall.id;
    const subEntry =
      state.subagentByToolId[toolId] ?? state.archivedSubagentByToolId[toolId];
    const snapshot = snapshotSubagentEntry(subEntry);
    if (snapshot.length === 0) return part;
    const childAcpSessionId =
      Object.entries(state.childAcpSessionToToolId).find(
        ([, mappedToolId]) => mappedToolId === toolId,
      )?.[0] ??
      extractTaskChildBinding(part.toolCall.rawOutput)?.childAcpSessionId;
    return {
      ...part,
      toolCall: {
        ...part.toolCall,
        metadata: {
          ...part.toolCall.metadata,
          childAcpSessionId,
          subagentSnapshot: snapshot,
        },
      },
    };
  });
}

function parsePartsJson(partsJson: string): MessagePart[] {
  try {
    const parts = JSON.parse(partsJson) as MessagePart[];
    return Array.isArray(parts) ? parts : [];
  } catch {
    return [];
  }
}

async function enrichPartsJson(partsJson: string): Promise<string> {
  return enrichMessageParts(partsJson, useWorkspaceStore.getState().workspacePath);
}

function reviveStartTime(raw: unknown): Date {
  if (raw instanceof Date) return new Date(raw.getTime());
  if (typeof raw === "string" || typeof raw === "number") return new Date(raw);
  return new Date();
}

/** Deep-copy a stream entry so async flush survives beginPlanningPlaceholder. */
export function cloneStreamEntrySnapshot(entry: AgentStreamEntry): AgentStreamEntry {
  return {
    ...entry,
    parts: entry.parts.map((part) => ({
      ...part,
      toolCall: part.toolCall
        ? {
            ...part.toolCall,
            startTime: reviveStartTime(part.toolCall.startTime),
          }
        : undefined,
    })),
    toolCalls: entry.toolCalls.map((toolCall) => ({
      ...toolCall,
      startTime: reviveStartTime(toolCall.startTime),
    })),
    planEntries: [...entry.planEntries],
  };
}

/** Pick the best stream entry for parts_json before async work can clobber byKey. */
export function resolveStreamEntryForPersist(
  sessionId: string,
  actorId: string,
  hint?: AgentStreamEntry | null,
): AgentStreamEntry | undefined {
  if (hint && snapshotTranscriptParts(hint).length > 0) return hint;

  const key = `${sessionId}::${actorId}`;
  const live = useV2StreamingStore.getState().byKey[key];
  if (live && snapshotTranscriptParts(live).length > 0) return live;

  const archived = useV2StreamingStore
    .getState()
    .archived.filter((entry) => entry.sessionId === sessionId && entry.actorId === actorId)
    .reverse();
  return archived.find((entry) => snapshotTranscriptParts(entry).length > 0);
}

export async function syncStreamingToolOutputsFromLocalCache(
  sessionId: string,
  actorId: string,
): Promise<void> {
  const entry =
    useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
  const parts = snapshotTranscriptParts(entry);
  if (parts.length === 0) return;
  const partsJson = JSON.stringify(parts);
  const enrichedPartsJson = await enrichPartsJson(partsJson);
  if (enrichedPartsJson === partsJson) return;
  const enrichedParts = parsePartsJson(enrichedPartsJson);
  if (enrichedParts.length === 0) return;
  useV2StreamingStore.getState().replaceParts(sessionId, actorId, enrichedParts);
}

/** Called from the live MQTT handler when the turn ends. Snapshots live parts[]
 * onto the final reply as `parts_json` and persists that blob to libsql. */
export async function persistStreamingPartsForReply(
  sessionId: string,
  actorId: string,
  reply: TeamclawMessage,
  pendingReplies: TeamclawMessage[] = [],
  opts?: { streamEntrySnapshot?: AgentStreamEntry },
): Promise<TeamclawMessage> {
  const turnId = reply.turnId;
  if (!turnId) return reply;
  const snapshot =
    opts?.streamEntrySnapshot ??
    resolveStreamEntryForPersist(sessionId, actorId);
  const parts = mergeSubagentSnapshotsIntoParts(
    snapshotTranscriptParts(snapshot),
    sessionId,
    actorId,
  );
  if (parts.length === 0) return reply;

  const content = deriveAgentReplyContent(parts, pendingReplies.length > 0 ? pendingReplies : [reply]);
  Object.assign(reply, { content });

  const partsJson = JSON.stringify(parts);
  try {
    const enrichedPartsJson = await setMessageParts(
      reply.messageId,
      partsJson,
      useWorkspaceStore.getState().workspacePath,
    );
    Object.assign(reply, { partsJson: enrichedPartsJson });
    const enrichedParts = parsePartsJson(enrichedPartsJson);
    const live = useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
    if (
      enrichedParts.length > 0 &&
      live &&
      snapshot &&
      live.streamId === snapshot.streamId
    ) {
      useV2StreamingStore.getState().replaceParts(sessionId, actorId, enrichedParts);
    }
  } catch (e) {
    Object.assign(reply, { partsJson });
    console.warn("[streaming-persist] parts_json write failed:", e);
  }
  return reply;
}

/** @internal test helper */
export function transcriptPartsForTests(
  parts: MessagePart[],
  pending: TeamclawMessage[],
): { parts: MessagePart[]; content: string } {
  return {
    parts,
    content: deriveAgentReplyContent(parts, pending),
  };
}

export { joinTextPartsFromParts };
