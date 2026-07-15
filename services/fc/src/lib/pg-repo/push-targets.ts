/**
 * Push dispatch helpers — Drizzle/pg replacements for the Supabase RPCs:
 *   push_idempotency_claim(p_message_id)
 *   list_session_push_targets(p_session_id, p_exclude_actor_id)
 *
 * Called by buildPgPushDeps() in admin-handlers.ts.
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  pushIdempotency,
  sessionParticipants,
  actors,
  devicePushTokens,
  notificationPrefs,
  clientPresence,
  sessionMutes,
} from "../../db/schema/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

// ── pushIdempotencyClaim ──────────────────────────────────────────────────────
// Mirrors: INSERT INTO push_idempotency(message_id) ON CONFLICT DO NOTHING
// claimed = true only if THIS call actually inserted the row.
export async function pushIdempotencyClaim(
  db: DbLike,
  messageId: string,
): Promise<boolean> {
  const rows = await (db.insert(pushIdempotency) as any)
    .values({ messageId })
    .onConflictDoNothing()
    .returning({ messageId: pushIdempotency.messageId });
  return rows.length > 0;
}

// ── listSessionPushTargets ────────────────────────────────────────────────────

export interface PushToken {
  provider: string;
  token: string;
  device_id: string;
}

export interface PresenceEntry {
  device_id: string;
  foreground_until: string;
}

export interface PushPrefs {
  enabled: boolean;
  dnd_start_min?: number | null;
  dnd_end_min?: number | null;
  dnd_tz?: string | null;
}

export interface PushRecipient {
  user_id: string;
  tokens: PushToken[];
  prefs: PushPrefs;
  presence: PresenceEntry[];
  muted: boolean;
}

export interface SessionPushTargets {
  sender_display_name: string;
  recipients: PushRecipient[];
}

export async function listSessionPushTargets(
  db: DbLike,
  sessionId: string,
  excludeActorId: string,
): Promise<SessionPushTargets> {
  // 1. sender display name
  const senderRows = await db
    .select({ displayName: actors.displayName })
    .from(actors)
    .where(eq(actors.id, excludeActorId))
    .limit(1);
  const senderDisplayName = senderRows[0]?.displayName ?? "Someone";

  // 2. participants — member actors with a non-null user_id, excluding sender
  const participantRows = await db
    .select({
      actorId: sessionParticipants.actorId,
      userId: actors.userId,
    })
    .from(sessionParticipants)
    .innerJoin(actors, eq(actors.id, sessionParticipants.actorId))
    .where(
      and(
        eq(sessionParticipants.sessionId, sessionId),
        eq(actors.actorType, "member"),
        // exclude sender
        // We use a workaround: filter in JS because Drizzle ne() is not imported
      ),
    );

  // Filter out sender + actors without a user_id
  const recipients: PushRecipient[] = [];
  for (const p of participantRows) {
    if (p.actorId === excludeActorId) continue;
    if (!p.userId) continue;

    const userId = p.userId;

    // 3. tokens (non-revoked)
    const tokenRows = await db
      .select({
        provider: devicePushTokens.provider,
        token: devicePushTokens.token,
        deviceId: devicePushTokens.deviceId,
      })
      .from(devicePushTokens)
      .where(
        and(
          eq(devicePushTokens.userId, userId),
          isNull(devicePushTokens.revokedAt),
        ),
      );

    const tokens: PushToken[] = tokenRows.map((r) => ({
      provider: r.provider,
      token: r.token,
      device_id: r.deviceId,
    }));

    // 4. notification prefs (default: enabled=true, no DnD)
    const prefsRows = await db
      .select()
      .from(notificationPrefs)
      .where(eq(notificationPrefs.userId, userId))
      .limit(1);
    const prefsRow = prefsRows[0];
    const prefs: PushPrefs = prefsRow
      ? {
          enabled: prefsRow.enabled,
          dnd_start_min: prefsRow.dndStartMin ?? null,
          dnd_end_min: prefsRow.dndEndMin ?? null,
          dnd_tz: prefsRow.dndTz ?? null,
        }
      : { enabled: true };

    // 5. presence (foreground_until > now)
    const now = new Date();
    const presenceRows = await db
      .select({
        deviceId: clientPresence.deviceId,
        foregroundUntil: clientPresence.foregroundUntil,
      })
      .from(clientPresence)
      .where(
        and(
          eq(clientPresence.userId, userId),
          gt(clientPresence.foregroundUntil, now),
        ),
      );

    const presence: PresenceEntry[] = presenceRows.map((r) => ({
      device_id: r.deviceId,
      foreground_until: new Date(r.foregroundUntil).toISOString(),
    }));

    // 6. muted?
    const muteRows = await db
      .select({ userId: sessionMutes.userId })
      .from(sessionMutes)
      .where(
        and(
          eq(sessionMutes.userId, userId),
          eq(sessionMutes.sessionId, sessionId),
        ),
      )
      .limit(1);
    const muted = muteRows.length > 0;

    recipients.push({ user_id: userId, tokens, prefs, presence, muted });
  }

  return { sender_display_name: senderDisplayName, recipients };
}

// ── revokeDeviceToken ─────────────────────────────────────────────────────────
export async function revokeDeviceToken(
  db: DbLike,
  token: string,
): Promise<void> {
  await (db.update(devicePushTokens) as any)
    .set({ revokedAt: new Date() })
    .where(eq(devicePushTokens.token, token));
}
