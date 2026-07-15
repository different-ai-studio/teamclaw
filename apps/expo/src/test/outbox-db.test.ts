import { beforeEach, describe, expect, it } from "vitest";

import { createOutboxDao, type OutboxDao } from "../features/sessions/outbox-db";

type Row = Record<string, unknown>;

function createInMemoryDb() {
  const rows: Row[] = [];
  return {
    rows,
    async runAsync(sql: string, ...params: unknown[]): Promise<void> {
      if (/^INSERT OR IGNORE INTO outbox/i.test(sql)) {
        const [
          message_id, session_id, team_id, sender_actor_id, content,
          mention_actor_ids, reply_to_message_id, attachments,
          state, attempt_count, last_error, last_attempt_at, next_attempt_at,
          created_at,
        ] = params;
        if (rows.some((r) => r.message_id === message_id)) return;
        rows.push({
          message_id, session_id, team_id, sender_actor_id, content,
          mention_actor_ids, reply_to_message_id, attachments,
          state, attempt_count, last_error, last_attempt_at, next_attempt_at,
          created_at,
        });
        return;
      }
      if (/^UPDATE outbox SET state = \?, last_attempt_at = \?/i.test(sql)) {
        const [state, lastAttemptAt, messageId] = params;
        const row = rows.find((r) => r.message_id === messageId);
        if (row) {
          row.state = state;
          row.last_attempt_at = lastAttemptAt;
        }
        return;
      }
      if (/^UPDATE outbox SET state = 'delivered'/i.test(sql)) {
        const [messageId] = params;
        const row = rows.find((r) => r.message_id === messageId);
        if (row) row.state = "delivered";
        return;
      }
      if (/^UPDATE outbox SET state = 'pending', attempt_count = \?, next_attempt_at = \?, last_error = \?/i.test(sql)) {
        const [attempts, next, err, messageId] = params;
        const row = rows.find((r) => r.message_id === messageId);
        if (row) {
          row.state = "pending";
          row.attempt_count = attempts;
          row.next_attempt_at = next;
          row.last_error = err;
        }
        return;
      }
      if (/^UPDATE outbox SET state = 'failed'/i.test(sql)) {
        const [err, messageId] = params;
        const row = rows.find((r) => r.message_id === messageId);
        if (row) {
          row.state = "failed";
          row.last_error = err;
          row.next_attempt_at = null;
        }
        return;
      }
      if (/^UPDATE outbox SET state = 'pending', attempt_count = 0/i.test(sql)) {
        const [messageId] = params;
        const row = rows.find((r) => r.message_id === messageId);
        if (row) {
          row.state = "pending";
          row.attempt_count = 0;
          row.next_attempt_at = null;
          row.last_error = null;
        }
        return;
      }
      throw new Error("unhandled sql: " + sql);
    },
    async getAllAsync(sql: string, ...params: unknown[]): Promise<Row[]> {
      if (/SELECT \* FROM outbox WHERE state = 'pending'/i.test(sql)) {
        const [now] = params as [number];
        return rows.filter(
          (r) => r.state === "pending"
            && (r.next_attempt_at == null || (r.next_attempt_at as number) <= now),
        );
      }
      return [];
    },
    async getFirstAsync(sql: string, ...params: unknown[]): Promise<Row | null> {
      if (/SELECT \* FROM outbox WHERE message_id = \?/i.test(sql)) {
        const [messageId] = params;
        return rows.find((r) => r.message_id === messageId) ?? null;
      }
      return null;
    },
  };
}

describe("OutboxDao", () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let dao: OutboxDao;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    db = createInMemoryDb();
    dao = createOutboxDao(db as unknown as Parameters<typeof createOutboxDao>[0]);
  });

  it("enqueue is idempotent on messageId", async () => {
    const row = {
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: NOW,
    };
    await dao.enqueue(row);
    await dao.enqueue(row);
    expect(db.rows.length).toBe(1);
  });

  it("fetchDue returns pending rows with null or past nextAttemptAt", async () => {
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: NOW,
    });
    const due = await dao.fetchDue(NOW + 1000);
    expect(due.map((r) => r.messageId)).toEqual(["m1"]);
  });

  it("markDelivered transitions row state", async () => {
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: NOW,
    });
    await dao.markDelivered("m1");
    const row = await dao.getByMessageId("m1");
    expect(row?.state).toBe("delivered");
  });

  it("retry resets a failed row to pending", async () => {
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: NOW,
    });
    await dao.markFailedExhausted("m1", 20, "boom");
    await dao.retry("m1");
    const row = await dao.getByMessageId("m1");
    expect(row?.state).toBe("pending");
    expect(row?.attemptCount).toBe(0);
  });
});
