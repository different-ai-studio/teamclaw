import {
  loadMessages,
  loadSessions,
  saveMessages,
  saveSessions,
} from "../../lib/db/local-cache";
import { openCacheDb, type CacheDb } from "../../lib/db/cache-db";
import type { MessageAttachment, SessionMessage, SessionSummary } from "./session-types";

export type SessionDetailCacheEntry = {
  session: SessionSummary;
  messages: SessionMessage[];
};

export type SessionDetailCache = {
  load: (sessionId: string) => Promise<SessionDetailCacheEntry | null>;
  save: (sessionId: string, entry: SessionDetailCacheEntry) => Promise<void>;
  saveMessages: (sessionId: string, messages: SessionMessage[]) => Promise<void>;
  clear: (sessionId: string) => Promise<void>;
};

/**
 * Per-session metadata + timeline cache, mirroring iOS's SwiftData hydration:
 * paint from disk immediately, let the network refresh overlay on top.
 *
 * Backed by SQLite rather than two AsyncStorage blobs. The blobs were clamped
 * to the newest 200 messages and rewritten whole on every append — including on
 * every streaming flush, which is why the streaming write is coalesced upstream
 * in `session-detail-controller`. Rows carry no such clamp, so scrolling back
 * through a long session no longer has to hit the network.
 */
export function createSessionDetailCache(
  getCacheDb: () => Promise<CacheDb> = openCacheDb,
): SessionDetailCache {
  const toSessionMessage = (row: {
    messageId: string;
    sessionId: string;
    teamId: string;
    senderActorId: string;
    kind: string;
    content: string;
    model: string;
    turnId: string;
    replyToMessageId: string;
    metadata: unknown;
    attachments: unknown[];
    createdAt: string;
  }): SessionMessage => ({
    messageId: row.messageId,
    sessionId: row.sessionId,
    teamId: row.teamId,
    senderActorId: row.senderActorId,
    kind: row.kind,
    content: row.content,
    model: row.model,
    turnId: row.turnId,
    replyToMessageId: row.replyToMessageId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    attachments: row.attachments as MessageAttachment[],
  });

  return {
    async load(sessionId) {
      if (!sessionId) return null;
      try {
        const db = await getCacheDb();
        const messages = await loadMessages(db, sessionId);
        // The session row is scoped by team, and the caller only knows the
        // session id, so find it by walking the message rows' team back into
        // the sessions table. A session with no cached messages still has a
        // cached header if the list screen wrote one.
        const teamId = messages[0]?.teamId ?? "";
        const session = teamId
          ? (await loadSessions(db, teamId)).find(
              (row) => row.sessionId === sessionId,
            )
          : undefined;
        if (!session) return null;
        return {
          session: {
            sessionId: session.sessionId,
            teamId: session.teamId,
            title: session.title,
            summary: session.summary,
            participantCount: session.participantCount,
            participantActorIds: session.participantActorIds,
            lastMessagePreview: session.lastMessagePreview,
            lastMessageAt: session.lastMessageAt,
            createdAt: session.createdAt,
            createdBy: session.createdBy,
            hasUnread: session.hasUnread,
          },
          messages: messages.map(toSessionMessage),
        };
      } catch {
        return null;
      }
    },
    async save(sessionId, entry) {
      if (!sessionId) return;
      try {
        const db = await getCacheDb();
        const teamId = entry.session.teamId;
        if (teamId) {
          // Merge rather than replace: the sessions scope belongs to the list
          // screen, and blowing it away here would empty the list cache every
          // time a detail screen opened.
          const existing = await loadSessions(db, teamId);
          const merged = [
            ...existing.filter((row) => row.sessionId !== sessionId),
            {
              sessionId: entry.session.sessionId,
              teamId,
              title: entry.session.title,
              summary: entry.session.summary,
              participantCount: entry.session.participantCount,
              participantActorIds: entry.session.participantActorIds ?? [],
              lastMessagePreview: entry.session.lastMessagePreview,
              lastMessageAt: entry.session.lastMessageAt,
              createdAt: entry.session.createdAt,
              createdBy: entry.session.createdBy,
              hasUnread: entry.session.hasUnread ?? false,
            },
          ];
          await saveSessions(db, teamId, merged);
        }
        await this.saveMessages(sessionId, entry.messages);
      } catch {
        // best-effort
      }
    },
    async saveMessages(sessionId, messages) {
      if (!sessionId) return;
      try {
        await saveMessages(
          await getCacheDb(),
          sessionId,
          messages.map((message) => ({
            messageId: message.messageId,
            sessionId: message.sessionId || sessionId,
            teamId: message.teamId,
            senderActorId: message.senderActorId,
            kind: message.kind,
            content: message.content,
            model: message.model,
            turnId: message.turnId,
            replyToMessageId: message.replyToMessageId,
            metadata: message.metadata,
            attachments: message.attachments ?? [],
            createdAt: message.createdAt,
          })),
        );
      } catch {
        // best-effort
      }
    },
    async clear(sessionId) {
      if (!sessionId) return;
      try {
        await saveMessages(await getCacheDb(), sessionId, []);
      } catch {
        // ignore
      }
    },
  };
}
