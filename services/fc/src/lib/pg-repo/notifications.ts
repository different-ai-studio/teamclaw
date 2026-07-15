/**
 * Notifications + Presence domain — pg-repo implementation.
 *
 * Caller identity:
 *  - getNotificationPrefs / putNotificationPrefs: keyed by user_id (UUID).
 *    Resolved from ctx.userId (set via accessToken/userId at factory time).
 *  - muteSession / unmuteSession / listMutedSessions: keyed by user_id on
 *    session_mutes (the schema uses user_id, not actor_id).
 *  - registerDevicePushToken: keyed by user_id + device_id + provider.
 *  - writeForegroundPresence: keyed by user_id + device_id.
 *
 * Wire shape (snake_case) — matches supabase-repo + the desktop/iOS clients,
 * which consume the raw row directly (no client-side mapper for prefs):
 *   { user_id, enabled, dnd_start_min, dnd_end_min, dnd_tz, updated_at }
 * getNotificationPrefs returns null when no row exists so callers fall back to
 * their own DEFAULT_PREFS. The push pipeline reads prefs via push-targets.ts
 * (already snake_case), not through this method.
 */

import { eq, and } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  notificationPrefs,
  devicePushTokens,
  sessionMutes,
  clientPresence,
} from "../../db/schema/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface NotificationsCtx {
  userId?: string;
}

export function makeNotificationsRepo(db: DbLike, ctx: NotificationsCtx = {}) {
  function requireUserId(explicit?: string | null): string {
    const id = explicit ?? ctx.userId;
    if (!id) throw new Error("notifications: userId required but not provided");
    return id;
  }

  return {
    // ── getNotificationPrefs ────────────────────────────────────────────────
    async getNotificationPrefs() {
      const userId = ctx.userId ?? null;
      if (!userId) return null;
      const rows = await db
        .select()
        .from(notificationPrefs)
        .where(eq(notificationPrefs.userId, userId))
        .limit(1);
      const row = rows[0];
      return row ? mapNotificationPrefs(row) : null;
    },

    // ── putNotificationPrefs ────────────────────────────────────────────────
    // Accepts the snake_case prefs row the client POSTs:
    //   { user_id, enabled, dnd_start_min, dnd_end_min, dnd_tz, updated_at }
    // Identity is taken from the caller (ctx.userId), never the client body.
    async putNotificationPrefs(input: {
      user_id?: string | null;
      enabled?: boolean;
      dnd_start_min?: number | null;
      dnd_end_min?: number | null;
      dnd_tz?: string | null;
    }) {
      const userId = requireUserId(input.user_id);
      const enabled = input.enabled ?? true;
      const dndStartMin = input.dnd_start_min ?? null;
      const dndEndMin = input.dnd_end_min ?? null;
      const now = new Date();

      const insertValues: Record<string, unknown> = {
        userId,
        enabled,
        dndStartMin,
        dndEndMin,
        updatedAt: now,
      };
      const updateSet: Record<string, unknown> = {
        enabled,
        dndStartMin,
        dndEndMin,
        updatedAt: now,
      };
      // dnd_tz has a NOT NULL default; only override it when the caller sends one.
      if (input.dnd_tz != null) {
        insertValues.dndTz = input.dnd_tz;
        updateSet.dndTz = input.dnd_tz;
      }

      const [row] = await (db.insert(notificationPrefs) as any)
        .values(insertValues)
        .onConflictDoUpdate({
          target: notificationPrefs.userId,
          set: updateSet,
        })
        .returning();
      return mapNotificationPrefs(row);
    },

    // ── muteSession ─────────────────────────────────────────────────────────
    async muteSession(sessionId: string, input: { until?: string | null }) {
      const userId = requireUserId();
      await (db.insert(sessionMutes) as any)
        .values({ userId, sessionId })
        .onConflictDoUpdate({
          target: [sessionMutes.userId, sessionMutes.sessionId],
          set: { mutedAt: new Date() },
        });
      void input; // until not in current schema; accepted but not persisted
    },

    // ── unmuteSession ───────────────────────────────────────────────────────
    async unmuteSession(sessionId: string) {
      const userId = requireUserId();
      await db
        .delete(sessionMutes)
        .where(
          and(
            eq(sessionMutes.userId, userId),
            eq(sessionMutes.sessionId, sessionId)
          )
        );
    },

    // ── listMutedSessions ───────────────────────────────────────────────────
    async listMutedSessions() {
      const userId = requireUserId();
      const rows = await db
        .select({ sessionId: sessionMutes.sessionId })
        .from(sessionMutes)
        .where(eq(sessionMutes.userId, userId));
      return { items: rows.map((r) => r.sessionId) };
    },

    // ── registerDevicePushToken ─────────────────────────────────────────────
    async registerDevicePushToken(input: {
      deviceId: string;
      platform?: string;
      provider?: string;
      token: string;
      appVersion?: string | null;
    }) {
      const userId = requireUserId();
      const now = new Date();
      await (db.insert(devicePushTokens) as any)
        .values({
          userId,
          deviceId: input.deviceId,
          platform: input.platform ?? "ios",
          provider: input.provider ?? "apns",
          token: input.token,
          appVersion: input.appVersion ?? null,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [devicePushTokens.userId, devicePushTokens.deviceId, devicePushTokens.provider],
          set: {
            token: input.token,
            platform: input.platform ?? "ios",
            appVersion: input.appVersion ?? null,
            lastSeenAt: now,
          },
        });
    },

    // ── writeForegroundPresence ─────────────────────────────────────────────
    async writeForegroundPresence(input: { deviceId: string; foregroundUntil: string }) {
      const userId = requireUserId();
      await (db.insert(clientPresence) as any)
        .values({
          userId,
          deviceId: input.deviceId,
          foregroundUntil: new Date(input.foregroundUntil),
        })
        .onConflictDoUpdate({
          target: [clientPresence.userId, clientPresence.deviceId],
          set: {
            foregroundUntil: new Date(input.foregroundUntil),
          },
        });
    },
  };
}

function mapNotificationPrefs(row: {
  userId: string;
  enabled: boolean;
  dndStartMin: number | null;
  dndEndMin: number | null;
  dndTz: string | null;
  updatedAt: Date | string | null;
}) {
  return {
    user_id: row.userId,
    enabled: row.enabled,
    dnd_start_min: row.dndStartMin ?? null,
    dnd_end_min: row.dndEndMin ?? null,
    dnd_tz: row.dndTz ?? null,
    updated_at: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}
