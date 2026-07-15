/**
 * FC timer-triggered cron tasks — replace pg_cron.
 *
 * Two tasks correspond to the pg_cron functions removed in the fc-drop-supabase
 * migration:
 *   oss_sync_abandon_expired_sessions()  →  ossSyncAbandonExpiredSessions()
 *   oss_sync_gc_orphan_blobs()           →  ossSyncGcOrphanBlobs()
 */

import { and, eq, lt, sql, notExists } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  amuxcUploadSessions,
  amuxcBlobs,
  amuxcFileVersions,
  amuxcFiles,
} from "../db/schema/oss-sync.js";

// ---------------------------------------------------------------------------
// ossSyncAbandonExpiredSessions
// ---------------------------------------------------------------------------
// Mirrors:
//   UPDATE amuxc_upload_sessions SET status='abandoned'
//     WHERE status='pending' AND expires_at < now();
//   DELETE FROM amuxc_upload_sessions
//     WHERE status='abandoned' AND expires_at < now() - interval '24 hours';
// ---------------------------------------------------------------------------
export async function ossSyncAbandonExpiredSessions(
  db: Db
): Promise<{ abandoned: number; deleted: number }> {
  const now = new Date();

  // 1. Mark pending-but-expired sessions as abandoned.
  const abandonResult = await db
    .update(amuxcUploadSessions)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .set({ status: sql`'abandoned'` } as any)
    .where(
      and(
        eq(amuxcUploadSessions.status, "pending"),
        lt(amuxcUploadSessions.expiresAt, now)
      )
    )
    .returning({ id: amuxcUploadSessions.id });

  // 2. Delete abandoned sessions that expired more than 24 hours ago.
  const deleteResult = await db
    .delete(amuxcUploadSessions)
    .where(
      and(
        eq(amuxcUploadSessions.status, "abandoned"),
        lt(
          amuxcUploadSessions.expiresAt,
          sql`now() - interval '24 hours'`
        )
      )
    )
    .returning({ id: amuxcUploadSessions.id });

  return { abandoned: abandonResult.length, deleted: deleteResult.length };
}

// ---------------------------------------------------------------------------
// ossSyncGcOrphanBlobs
// ---------------------------------------------------------------------------
// Mirrors:
//   DELETE FROM amuxc_blobs b
//     WHERE b.created_at < now() - interval '7 days'
//       AND NOT EXISTS (
//         SELECT 1 FROM amuxc_file_versions v
//         JOIN amuxc_files f ON f.id = v.file_id
//         WHERE f.team_id = b.team_id AND v.content_hash = b.content_hash
//       );
// ---------------------------------------------------------------------------
export async function ossSyncGcOrphanBlobs(
  db: Db
): Promise<{ deleted: number }> {
  const deleteResult = await db
    .delete(amuxcBlobs)
    .where(
      and(
        lt(amuxcBlobs.createdAt, sql`now() - interval '7 days'`),
        notExists(
          db
            .select({ one: sql`1` })
            .from(amuxcFileVersions)
            .innerJoin(amuxcFiles, eq(amuxcFiles.id, amuxcFileVersions.fileId))
            .where(
              and(
                eq(amuxcFiles.teamId, amuxcBlobs.teamId),
                eq(amuxcFileVersions.contentHash, amuxcBlobs.contentHash)
              )
            )
        )
      )
    )
    .returning({ teamId: amuxcBlobs.teamId });

  return { deleted: deleteResult.length };
}

// ---------------------------------------------------------------------------
// runCronTask — dispatch by task name
// ---------------------------------------------------------------------------
export type CronTask = "oss-abandon-sessions" | "oss-gc-blobs";

export async function runCronTask(
  db: Db,
  task: string
): Promise<{ task: string; result: Record<string, number> }> {
  switch (task) {
    case "oss-abandon-sessions": {
      const result = await ossSyncAbandonExpiredSessions(db);
      return { task, result };
    }
    case "oss-gc-blobs": {
      const result = await ossSyncGcOrphanBlobs(db);
      return { task, result };
    }
    default:
      throw new Error(`Unknown cron task: ${task}`);
  }
}
