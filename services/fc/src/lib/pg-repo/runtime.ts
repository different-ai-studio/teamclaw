/**
 * Runtime domain — pg-repo implementation.
 *
 * Covers all agent_runtimes operations: upsert, get, list, cursor/model
 * updates, heartbeat probe.
 *
 * Natural upsert key: (agent_id, backend_session_id) — mirrors the Supabase
 * unique index agent_runtimes_agent_backend_uniq (migration 202604220027).
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { actors, teams } from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface RuntimeCtx {
  userId?: string;
  callerActorId?: string;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;


export function makeRuntimeRepo(db: DbLike, ctx: RuntimeCtx = {}) {

  return {










    /**
     * Connectivity probe + actor presence update.
     * Stamps last_active_at for the calling actor so clients see it as online.
     * Daemon tokens carry callerActorId (agent row); desktop/iOS member tokens
     * carry userId and fall back to updating every actor row for that user —
     * mirroring the Supabase `update_actor_last_active()` RPC.
     */
    async heartbeat() {
      await db.select({ one: teams.id }).from(teams).limit(1);
      const now = new Date();
      if (ctx.callerActorId) {
        await (db as any)
          .update(actors)
          .set({ lastActiveAt: now, updatedAt: now })
          .where(eq(actors.id, ctx.callerActorId));
        return;
      }
      if (ctx.userId) {
        await (db as any)
          .update(actors)
          .set({ lastActiveAt: now, updatedAt: now })
          .where(eq(actors.userId, ctx.userId));
      }
    },
  };
}
