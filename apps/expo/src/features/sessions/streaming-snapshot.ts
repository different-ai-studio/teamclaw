import { openCacheDb, type CacheDb } from "../../lib/db/cache-db";
import type { StreamingBuffer } from "./session-types";

/**
 * Partial agent output, persisted across a suspend.
 *
 * A streaming turn lives in an in-memory delta buffer; only the daemon's final
 * message reaches the timeline cache. If the OS reclaims a backgrounded app
 * mid-turn, everything the user watched appear is gone and the next launch
 * shows an empty bubble.
 *
 * Ported from iOS `flushStreamingForBackground` / `discardBackgroundSnapshot`.
 * Same shape: write on the way out, delete on the way back in, restore only
 * when the process actually died.
 */
export type StreamingSnapshotStore = {
  /** Persist the in-flight buffers. Replaces any previous snapshot. */
  save: (
    sessionId: string,
    buffers: ReadonlyMap<string, StreamingBuffer>,
  ) => Promise<void>;
  /** Restore a saved snapshot. Empty when the process survived (or never saved). */
  load: (sessionId: string) => Promise<Map<string, StreamingBuffer>>;
  /** Drop the snapshot. Idempotent. */
  clear: (sessionId: string) => Promise<void>;
};

export function createStreamingSnapshotStore(
  getCacheDb: () => Promise<CacheDb> = openCacheDb,
): StreamingSnapshotStore {
  return {
    async save(sessionId, buffers) {
      if (!sessionId) return;
      try {
        const db = await getCacheDb();
        // Clear first so repeated background/foreground cycles can't
        // accumulate a chain of stale partials, as iOS does.
        await db.runAsync("DELETE FROM streaming_snapshots WHERE session_id = ?", sessionId);
        const now = Date.now();
        for (const [agentId, buffer] of buffers) {
          // A completed buffer is already on its way to the timeline, and an
          // empty one would restore as a blank bubble — neither is worth
          // saving.
          if (buffer.isComplete) continue;
          if (buffer.text.length === 0) continue;
          await db.runAsync(
            `INSERT OR REPLACE INTO streaming_snapshots
               (session_id, agent_id, message_id, text, model, kind, started_at, saved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            sessionId,
            agentId,
            buffer.messageId,
            buffer.text,
            buffer.model ?? "",
            buffer.kind,
            buffer.startedAt,
            now,
          );
        }
      } catch {
        // Losing the snapshot costs a partial bubble, never correctness.
      }
    },
    async load(sessionId) {
      const restored = new Map<string, StreamingBuffer>();
      if (!sessionId) return restored;
      try {
        const db = await getCacheDb();
        const rows = await db.getAllAsync(
          "SELECT * FROM streaming_snapshots WHERE session_id = ?",
          sessionId,
        );
        for (const row of rows) {
          const agentId = String(row.agent_id ?? "");
          if (!agentId) continue;
          restored.set(agentId, {
            // Restored as incomplete: the turn was cut off, and marking it
            // complete would suppress the daemon's real final message when it
            // arrives.
            isComplete: false,
            messageId: String(row.message_id ?? ""),
            model: String(row.model ?? ""),
            text: String(row.text ?? ""),
            kind: String(row.kind ?? ""),
            startedAt: String(row.started_at ?? ""),
            senderActorId: agentId,
          });
        }
      } catch {
        return restored;
      }
      return restored;
    },
    async clear(sessionId) {
      if (!sessionId) return;
      try {
        const db = await getCacheDb();
        await db.runAsync("DELETE FROM streaming_snapshots WHERE session_id = ?", sessionId);
      } catch {
        // ignore
      }
    },
  };
}
