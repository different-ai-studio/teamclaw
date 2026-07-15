import { describe, expect, it, vi } from "vitest";
import type { ExpoMqttAdapter, ExpoMqttMessage } from "../lib/mqtt/expo-mqtt";
import { createTeamMqttClient } from "../lib/mqtt/team-mqtt";

function createFakeAdapter(): ExpoMqttAdapter & {
  emitMessage: (m: ExpoMqttMessage) => void;
} {
  let messageHandler: ((m: ExpoMqttMessage) => void) | null = null;
  return {
    async connect() {},
    async disconnect() {},
    async subscribe() {},
    async publish() {},
    onConnectionState: () => () => {},
    onMessage: (handler) => {
      messageHandler = handler;
      return () => {
        messageHandler = null;
      };
    },
    emitMessage(message) {
      messageHandler?.(message);
    },
  };
}

describe("TeamMqttClient", () => {
  it("fans out a message to all handlers whose filter matches the topic", async () => {
    const adapter = createFakeAdapter();
    const client = createTeamMqttClient({
      adapter,
      url: "mqtt://x",
      username: "actor",
      password: "tok",
      clientId: "client",
    });
    await client.start();

    const aHandler = vi.fn();
    const bHandler = vi.fn();
    client.subscribe("amux/t/+/runtime/+/state", aHandler);
    client.subscribe("amux/t/session/s/live", bHandler);

    const payload = new Uint8Array([1, 2, 3]);
    adapter.emitMessage({ topic: "amux/t/actor-a/runtime/r/state", payload });

    expect(aHandler).toHaveBeenCalledWith(payload, "amux/t/actor-a/runtime/r/state");
    expect(bHandler).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe that stops further deliveries", async () => {
    const adapter = createFakeAdapter();
    const client = createTeamMqttClient({
      adapter, url: "mqtt://x", username: "u", password: "p", clientId: "c",
    });
    await client.start();

    const handler = vi.fn();
    const unsubscribe = client.subscribe("amux/t/x", handler);
    unsubscribe();

    adapter.emitMessage({ topic: "amux/t/x", payload: new Uint8Array() });
    expect(handler).not.toHaveBeenCalled();
  });
});
