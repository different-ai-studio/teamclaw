import { describe, expect, it, vi } from "vitest";

import type { OutboxRow } from "../features/sessions/outbox-db";

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    messageId: "msg-1",
    sessionId: "session-1",
    teamId: "team-1",
    senderActorId: "member-1",
    content: "hello",
    mentionActorIds: ["agent-1"],
    replyToMessageId: null,
    attachments: [],
    state: "pending",
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    createdAt: 1_747_642_000_000,
    ...overrides,
  };
}

describe("publishOutboxRowViaOptionalMqtt", () => {
  it("rejects instead of pretending delivery when MQTT is unavailable", async () => {
    const { publishOutboxRowViaOptionalMqtt } = await import(
      "../features/sessions/session-outbox-publish"
    );

    await expect(publishOutboxRowViaOptionalMqtt(row(), null)).rejects.toThrow(
      /mqtt/i,
    );
  });

  it("publishes the row on the session live topic when MQTT is available", async () => {
    const { publishOutboxRowViaOptionalMqtt } = await import(
      "../features/sessions/session-outbox-publish"
    );
    const mqtt = { publish: vi.fn().mockResolvedValue(undefined) };

    await publishOutboxRowViaOptionalMqtt(row(), mqtt);

    expect(mqtt.publish).toHaveBeenCalledWith(
      "amux/team-1/session/session-1/live",
      expect.any(Uint8Array),
      false,
    );
  });
});
