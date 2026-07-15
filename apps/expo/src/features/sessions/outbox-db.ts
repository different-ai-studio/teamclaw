import type { MessageAttachment } from "./session-types";

export type OutboxState = "pending" | "inFlight" | "delivered" | "failed";

export type OutboxRow = {
  messageId: string;
  sessionId: string;
  teamId: string;
  senderActorId: string;
  content: string;
  mentionActorIds: string[];
  replyToMessageId: string | null;
  attachments: MessageAttachment[];
  state: OutboxState;
  attemptCount: number;
  lastError: string | null;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  createdAt: number;
};

export type NewOutboxRow = Pick<
  OutboxRow,
  | "messageId" | "sessionId" | "teamId" | "senderActorId"
  | "content" | "mentionActorIds" | "replyToMessageId"
  | "attachments" | "createdAt"
>;

export type OutboxSqliteDb = {
  runAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
  getAllAsync: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
  getFirstAsync: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown> | null>;
};

export type OutboxDao = {
  enqueue: (row: NewOutboxRow) => Promise<void>;
  fetchDue: (now: number) => Promise<OutboxRow[]>;
  markInFlight: (messageId: string, now: number) => Promise<void>;
  markDelivered: (messageId: string) => Promise<void>;
  markFailedRetry: (messageId: string, attemptCount: number, nextAttemptAt: number, error: string) => Promise<void>;
  markFailedExhausted: (messageId: string, attemptCount: number, error: string) => Promise<void>;
  retry: (messageId: string) => Promise<void>;
  getByMessageId: (messageId: string) => Promise<OutboxRow | null>;
};

function mapRow(raw: Record<string, unknown>): OutboxRow {
  return {
    messageId: String(raw.message_id),
    sessionId: String(raw.session_id),
    teamId: String(raw.team_id),
    senderActorId: String(raw.sender_actor_id),
    content: String(raw.content),
    mentionActorIds: JSON.parse(String(raw.mention_actor_ids ?? "[]")),
    replyToMessageId: raw.reply_to_message_id ? String(raw.reply_to_message_id) : null,
    attachments: JSON.parse(String(raw.attachments ?? "[]")),
    state: String(raw.state) as OutboxState,
    attemptCount: Number(raw.attempt_count ?? 0),
    lastError: raw.last_error ? String(raw.last_error) : null,
    lastAttemptAt: raw.last_attempt_at == null ? null : Number(raw.last_attempt_at),
    nextAttemptAt: raw.next_attempt_at == null ? null : Number(raw.next_attempt_at),
    createdAt: Number(raw.created_at ?? 0),
  };
}

export function createOutboxDao(db: OutboxSqliteDb): OutboxDao {
  return {
    async enqueue(row) {
      await db.runAsync(
        `INSERT OR IGNORE INTO outbox (
           message_id, session_id, team_id, sender_actor_id, content,
           mention_actor_ids, reply_to_message_id, attachments,
           state, attempt_count, last_error, last_attempt_at, next_attempt_at,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.messageId, row.sessionId, row.teamId, row.senderActorId, row.content,
        JSON.stringify(row.mentionActorIds), row.replyToMessageId,
        JSON.stringify(row.attachments),
        "pending", 0, null, null, null,
        row.createdAt,
      );
    },
    async fetchDue(now) {
      const rows = await db.getAllAsync(
        `SELECT * FROM outbox WHERE state = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC`,
        now,
      );
      return rows.map(mapRow);
    },
    async markInFlight(messageId, now) {
      await db.runAsync(
        `UPDATE outbox SET state = ?, last_attempt_at = ? WHERE message_id = ?`,
        "inFlight", now, messageId,
      );
    },
    async markDelivered(messageId) {
      await db.runAsync(
        `UPDATE outbox SET state = 'delivered', last_error = NULL WHERE message_id = ?`,
        messageId,
      );
    },
    async markFailedRetry(messageId, attemptCount, nextAttemptAt, error) {
      await db.runAsync(
        `UPDATE outbox SET state = 'pending', attempt_count = ?, next_attempt_at = ?, last_error = ?
         WHERE message_id = ?`,
        attemptCount, nextAttemptAt, error, messageId,
      );
    },
    async markFailedExhausted(messageId, attemptCount, error) {
      await db.runAsync(
        `UPDATE outbox SET state = 'failed', attempt_count = ?, last_error = ?, next_attempt_at = NULL
         WHERE message_id = ?`,
        attemptCount, error, messageId,
      );
    },
    async retry(messageId) {
      await db.runAsync(
        `UPDATE outbox SET state = 'pending', attempt_count = 0, next_attempt_at = NULL, last_error = NULL
         WHERE message_id = ?`,
        messageId,
      );
    },
    async getByMessageId(messageId) {
      const row = await db.getFirstAsync(
        `SELECT * FROM outbox WHERE message_id = ? LIMIT 1`,
        messageId,
      );
      return row ? mapRow(row) : null;
    },
  };
}
