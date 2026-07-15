import { create, toBinary } from "@bufbuild/protobuf";
import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
} from "@teamclaw/app/proto/teamclaw_pb";

import type { TeamMqttClient } from "../../lib/mqtt/team-mqtt";
import { uuidV4 } from "../../lib/uuid";
import type { OutboxRow } from "./outbox-db";

export async function publishOutboxRowViaMqtt(
  row: OutboxRow,
  mqtt: Pick<TeamMqttClient, "publish">,
): Promise<void> {
  const createdAtSeconds = BigInt(Math.floor(row.createdAt / 1000));
  const protoMessage = create(MessageSchema, {
    messageId: row.messageId,
    sessionId: row.sessionId,
    senderActorId: row.senderActorId,
    kind: MessageKind.TEXT,
    content: row.content,
    createdAt: createdAtSeconds,
  });
  const sessionMessage = create(SessionMessageEnvelopeSchema, {
    message: protoMessage,
    mentionActorIds: row.mentionActorIds,
  });
  const envelope = create(LiveEventEnvelopeSchema, {
    eventId: uuidV4(),
    eventType: "message.created",
    sessionId: row.sessionId,
    actorId: row.senderActorId,
    sentAt: createdAtSeconds,
    body: toBinary(SessionMessageEnvelopeSchema, sessionMessage),
  });

  await mqtt.publish(
    `amux/${row.teamId}/session/${row.sessionId}/live`,
    toBinary(LiveEventEnvelopeSchema, envelope),
    false,
  );
}

export async function publishOutboxRowViaOptionalMqtt(
  row: OutboxRow,
  mqtt: Pick<TeamMqttClient, "publish"> | null | undefined,
): Promise<void> {
  if (!mqtt) {
    throw new Error("MQTT is not connected; message remains pending.");
  }

  await publishOutboxRowViaMqtt(row, mqtt);
}
