/**
 * Heartbeat / presence — pg-repo implementation.
 *
 * This file used to be `runtime.ts` and covered every `agent_runtimes`
 * operation. That table was dropped (migration 20260803010000): per-session
 * agent state moved to `session_participants` (ADR-0005) and live state to the
 * `ActorPresence` retain (ADR-0004). Only the connectivity probe was left, and
 * it never touched `agent_runtimes` in the first place.
 */

import { eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { actors, teams } from "../../db/schema/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface HeartbeatCtx {
  userId?: string;
  callerActorId?: string;
}

export function makeHeartbeatRepo(db: DbLike, ctx: HeartbeatCtx = {}) {
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
