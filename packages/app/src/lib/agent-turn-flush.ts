import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import { logInterruptMsgDiag } from "@/lib/interrupt-msg-diag-core";
import { summarizePersistRelease } from "@/lib/interrupt-msg-diag";
import { bumpSessionListLastMessage } from "@/lib/session-list-preview";
import { persistStreamingPartsForReply, resolveStreamEntryForPersist } from "@/lib/streaming-persist";
import { upsertMessagesBatch, type MessageRow } from "@/lib/local-cache";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useV2StreamingStore, type AgentStreamEntry } from "@/stores/v2-streaming-store";
import { flushStreamDeltasFor } from "@/lib/stream-delta-buffer";

export function buildAgentReplyMessageRow(
  teamId: string,
  reply: TeamclawMessage,
): MessageRow {
  const now = new Date().toISOString();
  const createdAtSec = Number(reply.createdAt);
  return {
    id: reply.messageId,
    teamId,
    sessionId: reply.sessionId,
    turnId: reply.turnId || null,
    senderActorId: reply.senderActorId || null,
    replyToMessageId: null,
    kind: "agent_reply",
    content: reply.content,
    metadataJson: reply.metadataJson || null,
    model: reply.model || null,
    mentionsJson: null,
    origin: "mqtt-live",
    createdAt:
      Number.isFinite(createdAtSec) && createdAtSec > 0
        ? new Date(createdAtSec * 1000).toISOString()
        : now,
    updatedAt: now,
    deletedAt: null,
    syncedAt: now,
    partsJson:
      (reply as unknown as { partsJson?: string | null }).partsJson ?? null,
  };
}

export function upsertAgentReplyToCache(
  teamId: string,
  reply: TeamclawMessage,
  logLabel = "flush agent_reply",
): void {
  upsertMessagesBatch([buildAgentReplyMessageRow(teamId, reply)]).catch((e) => {
    console.warn(`[cache] ${logLabel} upsert failed:`, e);
  });
}

export function releaseStreamAfterAgentReplyPersist(
  sessionId: string,
  actorId: string,
  enrichedReply: TeamclawMessage,
  opts: {
    trigger: string;
    persistedPartsJson?: string;
    streamEntrySnapshot?: AgentStreamEntry;
  },
): void {
  useV2StreamingStore.getState().finishSessionActor(sessionId, actorId, {
    reason: "flushTurnAgentReply",
  });
  useV2StreamingStore.getState().releaseActorAfterPersist(sessionId, actorId, {
    persistedPartsJson: opts.persistedPartsJson,
    persistedSourceStreamId: opts.streamEntrySnapshot?.streamId,
  });
  useV2StreamingStore.getState().clearStaleStreamErrors(sessionId, actorId);
  const archivedAfter = useV2StreamingStore.getState().archived.filter(
    (entry) => entry.sessionId === sessionId && entry.actorId === actorId,
  ).length;
  logInterruptMsgDiag("flush.done", {
    sessionId,
    actorId,
    trigger: opts.trigger,
    messageId: enrichedReply.messageId,
    archivedCountAfter: archivedAfter,
    storeMessageCount:
      useSessionMessageStore.getState().messages[sessionId]?.length ?? 0,
  });
}

export function bumpPreviewFromAgentReply(
  sessionId: string,
  reply: TeamclawMessage,
): void {
  const createdAtSec = Number(reply.createdAt);
  bumpSessionListLastMessage(sessionId, reply.content, {
    at:
      Number.isFinite(createdAtSec) && createdAtSec > 0
        ? new Date(createdAtSec * 1000).toISOString()
        : undefined,
  });
}

/** Shared post-persist commit: store, cache, release stream, session preview. */
export function commitFlushedAgentReply(
  sessionId: string,
  actorId: string,
  enrichedReply: TeamclawMessage,
  opts: {
    trigger: string;
    teamId: string;
    streamEntrySnapshot?: AgentStreamEntry;
    persistedStage: string;
    persistedExtras?: Record<string, unknown>;
  },
): void {
  useSessionMessageStore
    .getState()
    .replaceTurnAgentRepliesInStore(sessionId, enrichedReply);
  upsertAgentReplyToCache(opts.teamId, enrichedReply);
  const persistedPartsJson = (enrichedReply as { partsJson?: string }).partsJson;
  logInterruptMsgDiag(opts.persistedStage, {
    sessionId,
    actorId,
    trigger: opts.trigger,
    messageId: enrichedReply.messageId,
    turnId: enrichedReply.turnId,
    contentLength: (enrichedReply.content ?? "").trim().length,
    ...summarizePersistRelease({ persistedPartsJson }),
    ...opts.persistedExtras,
  });
  releaseStreamAfterAgentReplyPersist(sessionId, actorId, enrichedReply, {
    trigger: opts.trigger,
    persistedPartsJson,
    streamEntrySnapshot: opts.streamEntrySnapshot,
  });
  bumpPreviewFromAgentReply(sessionId, enrichedReply);
}

export async function executeAgentTurnFlush(args: {
  sessionId: string;
  actorId: string;
  trigger: string;
  teamId: string;
  reply: TeamclawMessage;
  pendingReplies: TeamclawMessage[];
  streamEntrySnapshot?: AgentStreamEntry;
  beforePersist?: () => void;
  afterEnriched?: (enriched: TeamclawMessage) => void;
  persistedStage: string;
}): Promise<void> {
  // Drain any buffered text deltas so persisted parts include all arrived text.
  flushStreamDeltasFor(args.sessionId, args.actorId);
  args.beforePersist?.();
  const live = useV2StreamingStore.getState().byKey[`${args.sessionId}::${args.actorId}`];
  const streamEntryForPersist = resolveStreamEntryForPersist(
    args.sessionId,
    args.actorId,
    live ?? args.streamEntrySnapshot,
  );
  const enrichedReply = await persistStreamingPartsForReply(
    args.sessionId,
    args.actorId,
    args.reply,
    args.pendingReplies,
    { streamEntrySnapshot: streamEntryForPersist },
  );
  args.afterEnriched?.(enrichedReply);
  commitFlushedAgentReply(args.sessionId, args.actorId, enrichedReply, {
    trigger: args.trigger,
    teamId: args.teamId,
    streamEntrySnapshot: streamEntryForPersist,
    persistedStage: args.persistedStage,
  });
}
