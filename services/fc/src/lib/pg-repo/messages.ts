/**
 * Messages domain — pg-repo implementation.
 *
 * Duplicate-id handling:
 *   pglite throws a Postgres error with code "23505" on PK violation.
 *   We catch it and rethrow as ApiError(409, "conflict") — matching the
 *   mapSupabaseError(23505) behaviour in http-utils.ts so callers see a
 *   consistent error.code of either "23505" or "conflict".
 */

import { and, asc, eq, gt } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { messages } from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

/** Snake-case record shape that dispatchPush reads off the DB row. */
export interface MessagePushRecord {
  id: string;
  session_id: string;
  team_id: string;
  sender_actor_id: string | null;
  kind: string;
  content: string;
}

export interface MessagesRepoDeps {
  /** Optional push hook — called after every successful INSERT. Best-effort:
   *  errors are logged and swallowed so insert outcome is never affected. */
  dispatchPush?: (record: MessagePushRecord) => Promise<void>;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

function mapMessage(r: any) {
  return {
    id: r.id,
    teamId: r.teamId,
    sessionId: r.sessionId,
    turnId: r.turnId ?? null,
    senderActorId: r.senderActorId ?? null,
    replyToMessageId: r.replyToMessageId ?? null,
    kind: r.kind ?? "text",
    content: r.content ?? "",
    metadata: r.metadata ?? null,
    model: r.model ?? null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

// Snake_case sync wire shape — consumed directly by the client's
// lib/sync/message-sync.ts (no client mapper). Matches supabase MESSAGE_SYNC_COLUMNS.
function mapMessageSyncRow(r: any) {
  return {
    id: r.id,
    team_id: r.teamId,
    session_id: r.sessionId,
    turn_id: r.turnId ?? null,
    sender_actor_id: r.senderActorId ?? null,
    reply_to_message_id: r.replyToMessageId ?? null,
    kind: r.kind ?? "text",
    content: r.content ?? "",
    metadata: r.metadata ?? null,
    model: r.model ?? null,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

function isPkViolation(err: any): boolean {
  // pglite surfaces the code directly on the error object
  const code = err?.code ?? err?.cause?.code;
  return code === "23505";
}

export function makeMessagesRepo(db: DbLike, deps?: MessagesRepoDeps) {
  return {
    // ── listMessages ──────────────────────────────────────────────────────────
    async listMessages(sessionId: string) {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      return rows.map(mapMessage);
    },

    // ── insertMessage ─────────────────────────────────────────────────────────
    async insertMessage(
      sessionId: string,
      input: {
        id?: string;
        teamId: string;
        kind?: string;
        content: string;
        senderActorId?: string | null;
        replyToMessageId?: string | null;
        turnId?: string | null;
        model?: string | null;
        metadata?: Record<string, unknown> | null;
        createdAt?: string;
      },
    ) {
      const row: any = {
        sessionId,
        teamId: input.teamId,
        kind: input.kind ?? "text",
        content: input.content,
        senderActorId: input.senderActorId ?? null,
        replyToMessageId: input.replyToMessageId ?? null,
        turnId: input.turnId ?? null,
        model: input.model ?? null,
        metadata: input.metadata ?? {},
      };
      if (input.id) row.id = input.id;
      if (input.createdAt) row.createdAt = new Date(input.createdAt);

      try {
        const [r] = await (db.insert(messages) as any).values(row).returning();

        // Dispatch push notification best-effort: errors are caught and logged
        // so that a push failure never rolls back or rejects the message insert.
        if (deps?.dispatchPush) {
          const pushRecord: MessagePushRecord = {
            id: r.id,
            session_id: r.sessionId,
            team_id: r.teamId,
            sender_actor_id: r.senderActorId ?? null,
            kind: r.kind ?? "text",
            content: r.content ?? "",
          };
          deps.dispatchPush(pushRecord).catch((err: unknown) => {
            console.error("[push] dispatchPush failed (swallowed):", err);
          });
        }

        return mapMessage(r);
      } catch (err: any) {
        if (isPkViolation(err)) {
          throw new ApiError(409, "conflict", "Duplicate message id", { cause: err });
        }
        throw err;
      }
    },

    // ── patchMessage ──────────────────────────────────────────────────────────
    async patchMessage(messageId: string, patch: { content?: string; metadata?: unknown }) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.content !== undefined) updates.content = patch.content;
      if (patch.metadata !== undefined) updates.metadata = patch.metadata;

      const [r] = await (db.update(messages) as any)
        .set(updates)
        .where(eq(messages.id, messageId))
        .returning();
      if (!r) return null;
      return { id: r.id, content: r.content };
    },

    // ── deleteMessage ─────────────────────────────────────────────────────────
    async deleteMessage(messageId: string) {
      await (db.delete(messages) as any).where(eq(messages.id, messageId));
    },

    // ── listMessagesForSessionSince ───────────────────────────────────────────
    async listMessagesForSessionSince(sessionId: string, updatedAfter: string | null) {
      const rows = updatedAfter
        ? await db
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.sessionId, sessionId),
                gt(messages.updatedAt, new Date(updatedAfter)),
              ),
            )
        : await db.select().from(messages).where(eq(messages.sessionId, sessionId));
      return rows.map(mapMessageSyncRow);
    },
  };
}
