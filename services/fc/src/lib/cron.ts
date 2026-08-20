/**
 * FC timer-triggered cron tasks — replace pg_cron.
 *
 * Two tasks correspond to the pg_cron functions removed in the fc-drop-supabase
 * migration:
 *   oss_sync_abandon_expired_sessions()  →  ossSyncAbandonExpiredSessions()
 *   oss_sync_gc_orphan_blobs()           →  ossSyncGcOrphanBlobs()
 */

import { and, eq, inArray, lt, sql, notExists } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  amuxcUploadSessions,
  amuxcBlobs,
  amuxcFileVersions,
  amuxcFiles,
} from "../db/schema/oss-sync.js";
import { getTeamBlobStorage, type BlobStorage } from "./team-blob-storage.js";

/** What the cron tasks need injected; everything defaults to the real thing. */
export interface CronDeps {
  storage?: BlobStorage;
  /** Blobs collected per GC run — see `GC_BATCH_LIMIT`. Tests use small ones. */
  limit?: number;
}

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
//
// ...and then deletes the bytes. The pg_cron original could only reach the
// registry, so "garbage collection" meant forgetting where the garbage was:
// every collected blob left its object behind with nothing left pointing at it.
//
// Order is deliberate. The row goes first, the object second:
//
//   * row deleted, object delete fails  → a leaked object. Exactly the old
//     behaviour, and the next `prepare` for that hash simply re-uploads.
//   * object deleted, row survives      → `prepare` would see a `verified` row,
//     tell the client to skip the upload, and `complete` would then 422 on a
//     blob that is not there. That one is a broken client, not just waste.
//
// A failure to delete an object is counted and logged, never thrown: one
// unhappy key must not abandon the rest of the sweep.
//
// `objectsDeleted` counts delete calls that came back clean, which is not quite
// the same as bytes reclaimed: deleting an absent key succeeds too. It has to
// work that way — a collector must be able to finish after a half-done previous
// run — but it does mean a deployment whose objects sit under a key layout the
// current storage config no longer produces will report happy deletes while the
// real bytes stay put. Those need a one-off sweep by prefix, not this task.
//
// The sweep is CAPPED, because adding object deletes changed what one run costs.
// Deleting rows was a single statement whose size did not matter; deleting bytes
// is one network round trip per blob, and the FC function this runs in has a
// 30-second timeout (`s.yaml`). The first run after this ships would have found
// 45,610 orphans on belayo — the DELETE would commit and the function would then
// be killed a few hundred keys into the loop, leaking the rest with no row left
// to name them. A capped run drains over several days instead, and says so.
// ---------------------------------------------------------------------------

/** Blobs collected per run. ~30ms/delete against OSS leaves room in 30s. */
const GC_BATCH_LIMIT = 500;

/** `created_at` older than 7 days and no file version pointing at the hash. */
function orphanBlobPredicate(db: Db) {
  return and(
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
  );
}

export async function ossSyncGcOrphanBlobs(
  db: Db,
  deps: CronDeps = {}
): Promise<{
  deleted: number;
  objectsDeleted: number;
  objectsFailed: number;
  capped: number;
}> {
  const limit = deps.limit ?? GC_BATCH_LIMIT;

  // Postgres DELETE takes no LIMIT, so pick the batch first. `oss_key` is
  // derived from (team_id, content_hash) — the primary key — so it identifies a
  // row exactly.
  const batch = await db
    .select({ ossKey: amuxcBlobs.ossKey })
    .from(amuxcBlobs)
    .where(orphanBlobPredicate(db))
    .limit(limit);

  if (batch.length === 0) {
    return { deleted: 0, objectsDeleted: 0, objectsFailed: 0, capped: 0 };
  }

  // The predicate is re-checked here, not just used to build the list: between
  // the select and the delete a blob can acquire a file version, and collecting
  // one that just became live would delete bytes somebody now references.
  const deleteResult = await db
    .delete(amuxcBlobs)
    .where(
      and(
        inArray(amuxcBlobs.ossKey, batch.map((b) => b.ossKey)),
        orphanBlobPredicate(db)
      )
    )
    .returning({ teamId: amuxcBlobs.teamId, ossKey: amuxcBlobs.ossKey });

  // Hitting the cap is normal while a backlog drains, but it must be visible:
  // a run that silently stops at 500 reads exactly like a run that finished.
  // 0/1 rather than a boolean because `runCronTask` reports a map of numbers.
  const capped = batch.length === limit ? 1 : 0;
  if (capped) {
    console.warn(
      `[cron/oss-gc-blobs] hit the ${limit}-blob cap; more orphans remain for the next run`
    );
  }

  if (deleteResult.length === 0) {
    return { deleted: 0, objectsDeleted: 0, objectsFailed: 0, capped };
  }

  // Resolved only once there is something to delete: building the real store
  // reads env a caller with nothing to collect should not have to provide.
  const storage = deps.storage ?? getTeamBlobStorage();

  let objectsDeleted = 0;
  let objectsFailed = 0;
  for (const { teamId, ossKey } of deleteResult) {
    try {
      await storage.remove(ossKey);
      objectsDeleted++;
    } catch (e) {
      objectsFailed++;
      // The row is already gone, so this line is the only remaining record of
      // which bytes leaked. Carry the team id with it.
      console.error(
        "[cron/oss-gc-blobs] failed to delete object:",
        teamId,
        ossKey,
        e,
      );
    }
  }

  return { deleted: deleteResult.length, objectsDeleted, objectsFailed, capped };
}

// ---------------------------------------------------------------------------
// runCronTask — dispatch by task name
// ---------------------------------------------------------------------------
export type CronTask = "oss-abandon-sessions" | "oss-gc-blobs";

export async function runCronTask(
  db: Db,
  task: string,
  deps: CronDeps = {}
): Promise<{ task: string; result: Record<string, number> }> {
  switch (task) {
    case "oss-abandon-sessions": {
      const result = await ossSyncAbandonExpiredSessions(db);
      return { task, result };
    }
    case "oss-gc-blobs": {
      const result = await ossSyncGcOrphanBlobs(db, deps);
      return { task, result };
    }
    default:
      throw new Error(`Unknown cron task: ${task}`);
  }
}
