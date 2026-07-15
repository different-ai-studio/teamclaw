/**
 * Load cron (and other cloud-backed) session messages into the v2 message store.
 * Used when navigating from Cron run history so the chat pane does not wait on
 * libsql sync / refresh-trigger quirks.
 */
import { create as createMessage } from "@bufbuild/protobuf";
import { getBackend } from "@/lib/backend";
import type { MessageHistoryRow } from "@/lib/backend/types";
import { MessageKind, MessageSchema, type Message } from "@/lib/proto/teamclaw_pb";
import { isTauri } from "@/lib/utils";
import { syncMessagesForSession } from "@/lib/sync/message-sync";
import { useSessionMessageStore } from "@/stores/session-message-store";

const KIND_MAP: Record<string, MessageKind> = {
  text: MessageKind.TEXT,
  system: MessageKind.SYSTEM,
  agent_thinking: MessageKind.AGENT_THINKING,
  agent_tool_call: MessageKind.AGENT_TOOL_CALL,
  agent_tool_result: MessageKind.AGENT_TOOL_RESULT,
  agent_reply: MessageKind.AGENT_REPLY,
};

function historyRowToProto(row: MessageHistoryRow): Message {
  return createMessage(MessageSchema, {
    messageId: row.id,
    sessionId: row.session_id,
    senderActorId: row.sender_actor_id ?? "",
    kind: KIND_MAP[row.kind] ?? MessageKind.TEXT,
    content: row.content ?? "",
    model: row.model ?? "",
    turnId: row.turn_id ?? "",
    createdAt: BigInt(Math.floor(new Date(row.created_at).getTime() / 1000)),
  });
}

function fallbackSummaryMessage(
  sessionId: string,
  summary: string,
  runId?: string,
): Message {
  const id = runId ? `cron-summary-${runId}` : `cron-summary-${sessionId}`;
  return createMessage(MessageSchema, {
    messageId: id,
    sessionId,
    senderActorId: "",
    kind: MessageKind.AGENT_REPLY,
    content: summary,
    model: "",
    turnId: "",
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
  });
}

export type HydrateCronSessionMessagesOpts = {
  /** When Cloud has no rows yet, show this text so the run is not a blank thread. */
  fallbackSummary?: string | null;
  runId?: string;
  /** Warm libsql cache after painting from Cloud (desktop only). */
  syncCache?: boolean;
};

/**
 * Pull messages from Cloud into `useSessionMessageStore`, optionally seeding a
 * one-off agent bubble from the cron run record when the backend is still empty.
 *
 * @returns number of messages now in the store for this session
 */
export async function hydrateCronSessionMessages(
  sessionId: string,
  opts?: HydrateCronSessionMessagesOpts,
): Promise<number> {
  let rows: MessageHistoryRow[] = [];
  try {
    rows = await getBackend().messages.listMessages(sessionId);
  } catch (error) {
    console.warn(
      "[cron-session] cloud listMessages failed:",
      error instanceof Error ? error.message : error,
    );
  }

  let protos: Message[];
  if (rows.length > 0) {
    protos = rows.map(historyRowToProto);
  } else {
    const summary = opts?.fallbackSummary?.trim();
    if (!summary) {
      useSessionMessageStore.getState().setMessages(sessionId, []);
      return 0;
    }
    protos = [fallbackSummaryMessage(sessionId, summary, opts?.runId)];
  }

  useSessionMessageStore.getState().setMessages(sessionId, protos);

  if (opts?.syncCache !== false && isTauri() && rows.length > 0) {
    try {
      const teamId = await getBackend().sessions.getSessionTeamId(sessionId);
      if (teamId) {
        await syncMessagesForSession(sessionId, teamId, { full: true });
        const { loadMessagesForSession } = await import("@/lib/local-cache");
        const fresh = await loadMessagesForSession(sessionId, false);
        if (fresh.length > 0) {
          useSessionMessageStore.getState().setMessages(
            sessionId,
            fresh.map((r) =>
              createMessage(MessageSchema, {
                messageId: r.id,
                sessionId: r.sessionId,
                senderActorId: r.senderActorId ?? "",
                kind: KIND_MAP[r.kind] ?? MessageKind.TEXT,
                content: r.content ?? "",
                model: r.model ?? "",
                turnId: r.turnId ?? "",
                createdAt: BigInt(Math.floor(new Date(r.createdAt).getTime() / 1000)),
              }),
            ),
          );
        }
      }
    } catch (error) {
      console.warn(
        "[cron-session] cache sync failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  return protos.length;
}
