import { describe, expect, it, vi } from "vitest";

type MockMqttHandler = (topic: string, payload: Uint8Array) => void;
type MockMqttEvent = "close" | "connect" | "error" | "message" | "offline";

function createMockClient() {
  const listeners = {
    close: new Set<() => void>(),
    connect: new Set<() => void>(),
    error: new Set<(error: Error) => void>(),
    message: new Set<MockMqttHandler>(),
    offline: new Set<() => void>(),
  };

  return {
    subscribe: vi.fn((topic: string, callback: (error?: Error | null) => void) => {
      callback(null);
    }),
    publish: vi.fn(
      (
        topic: string,
        payload: Uint8Array | string,
        options: { retain?: boolean },
        callback: (error?: Error | null) => void,
      ) => {
        callback(null);
      },
    ),
    end: vi.fn((force: boolean, options: Record<string, never>, callback: () => void) => {
      callback();
    }),
    on(event: MockMqttEvent, handler: (() => void) | ((error: Error) => void) | MockMqttHandler) {
      listeners[event].add(handler as never);
      return this;
    },
    once(event: MockMqttEvent, handler: (() => void) | ((error: Error) => void) | MockMqttHandler) {
      listeners[event].add(handler as never);
      return this;
    },
    removeListener(
      event: MockMqttEvent,
      handler: (() => void) | ((error: Error) => void) | MockMqttHandler,
    ) {
      listeners[event].delete(handler as never);
      return this;
    },
    emitConnect() {
      for (const handler of [...listeners.connect]) {
        handler();
      }
    },
    emitError(error: Error) {
      for (const handler of [...listeners.error]) {
        handler(error);
      }
    },
    emitClose() {
      for (const handler of [...listeners.close]) {
        handler();
      }
    },
    emitOffline() {
      for (const handler of [...listeners.offline]) {
        handler();
      }
    },
    emitMessage(topic: string, payload: Uint8Array) {
      for (const handler of [...listeners.message]) {
        handler(topic, payload);
      }
    },
  };
}

describe("createExpoMqttAdapter", () => {
  it("uses the native MQTT module when one is available", async () => {
    const listeners = new Map<string, Set<(event: never) => void>>();
    const nativeModule = {
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const nativeEvents = {
      addListener: vi.fn((event: string, handler: (event: never) => void) => {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(handler);
        listeners.set(event, eventListeners);
        return {
          remove: () => eventListeners.delete(handler),
        };
      }),
    };
    const { createExpoMqttAdapter } = await import("../lib/mqtt/expo-mqtt");
    const adapter = createExpoMqttAdapter({ nativeModule, nativeEvents });
    const states: string[] = [];
    const messages: Array<{ topic: string; payload: Uint8Array }> = [];
    adapter.onConnectionState((state) => states.push(state));
    adapter.onMessage((message) => messages.push(message));

    await adapter.connect({
      url: "mqtts://ai.ucar.cc:8883",
      options: {
        clientId: "client-1",
        username: "actor-1",
        password: "token-1",
        keepalive: 90,
        connectTimeout: 15000,
      },
    });
    await adapter.subscribe("amux/team-1/session/session-1/live");
    await adapter.publish("topic", new Uint8Array([1, 2, 3]), true);
    listeners.get("TeamClawMqttConnectionState")?.forEach((handler) =>
      handler({ state: "connected" } as never),
    );
    listeners.get("TeamClawMqttMessage")?.forEach((handler) =>
      handler({ topic: "topic", payload: [7, 8] } as never),
    );
    await adapter.disconnect();

    expect(nativeModule.connect).toHaveBeenCalledWith({
      host: "ai.ucar.cc",
      port: 8883,
      useTls: true,
      username: "actor-1",
      password: "token-1",
      clientId: "client-1",
      keepalive: 90,
      connectTimeout: 15000,
    });
    expect(nativeModule.subscribe).toHaveBeenCalledWith("amux/team-1/session/session-1/live");
    expect(nativeModule.publish).toHaveBeenCalledWith("topic", [1, 2, 3], true);
    expect(nativeModule.disconnect).toHaveBeenCalled();
    expect(states).toEqual(["connecting", "connected", "disconnected"]);
    expect(messages).toEqual([{ topic: "topic", payload: new Uint8Array([7, 8]) }]);
    expect(nativeEvents.addListener).toHaveBeenCalledWith(
      "TeamClawMqttMessage",
      expect.any(Function),
    );
    expect(nativeEvents.addListener).toHaveBeenCalledWith(
      "TeamClawMqttConnectionState",
      expect.any(Function),
    );
  });

  it("waits for connect readiness and rejects on connection error", async () => {
    const client = createMockClient();
    const createClient = vi.fn(() => client);
    const { createExpoMqttAdapter } = await import("../lib/mqtt/expo-mqtt");
    const adapter = createExpoMqttAdapter({ createClient });

    let settled = false;
    const connectPromise = adapter.connect({ url: "mqtt://broker.example.com" }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    client.emitConnect();
    await connectPromise;

    expect(settled).toBe(true);
    expect(createClient).toHaveBeenCalledWith("mqtt://broker.example.com", undefined);
  });

  it("rejects connect when the wrapped client emits an error", async () => {
    const client = createMockClient();
    const { createExpoMqttAdapter } = await import("../lib/mqtt/expo-mqtt");
    const adapter = createExpoMqttAdapter({ createClient: () => client });

    const connectPromise = adapter.connect({ url: "mqtt://broker.example.com" });
    client.emitError(new Error("broker unavailable"));

    await expect(connectPromise).rejects.toThrow("broker unavailable");
  });

  it("forwards connect subscribe publish and disconnect to the wrapped client", async () => {
    const client = createMockClient();
    const createClient = vi.fn(() => client);
    const { createExpoMqttAdapter } = await import("../lib/mqtt/expo-mqtt");
    const adapter = createExpoMqttAdapter({ createClient });

    const connectPromise = adapter.connect({
      url: "mqtt://broker.example.com",
      options: {
        clientId: "client-1",
        username: "user-1",
        password: "secret",
      },
    });
    client.emitConnect();
    await connectPromise;

    await adapter.subscribe("amux/team-1/session/session-1/live");
    await adapter.publish("topic", new Uint8Array([1, 2, 3]), true);
    await adapter.disconnect();

    expect(createClient).toHaveBeenCalledWith("mqtt://broker.example.com", {
      clientId: "client-1",
      username: "user-1",
      password: "secret",
    });
    expect(client.subscribe).toHaveBeenCalledWith(
      "amux/team-1/session/session-1/live",
      expect.any(Function),
    );
    expect(client.publish).toHaveBeenCalledWith(
      "topic",
      new Uint8Array([1, 2, 3]),
      { retain: true },
      expect.any(Function),
    );
    expect(client.end).toHaveBeenCalledWith(false, {}, expect.any(Function));
  });

  it("reports connection state changes and settles pending connect on disconnect", async () => {
    const client = createMockClient();
    const { createExpoMqttAdapter } = await import("../lib/mqtt/expo-mqtt");
    const adapter = createExpoMqttAdapter({ createClient: () => client });
    const states: string[] = [];
    adapter.onConnectionState((state) => {
      states.push(state);
    });

    const connectPromise = adapter.connect({ url: "mqtt://broker.example.com" });
    await expect(adapter.disconnect()).resolves.toBeUndefined();
    await expect(connectPromise).rejects.toThrow("MQTT connection was closed before becoming ready");

    const reconnectPromise = adapter.connect({ url: "mqtt://broker.example.com" });
    client.emitConnect();
    await reconnectPromise;
    client.emitOffline();
    client.emitClose();

    expect(states).toEqual([
      "connecting",
      "disconnected",
      "connecting",
      "connected",
      "disconnected",
      "disconnected",
    ]);
  });

  it("registers multiple message handlers and forwards wrapped client messages", async () => {
    const client = createMockClient();
    const { createExpoMqttAdapter } = await import("../lib/mqtt/expo-mqtt");
    const adapter = createExpoMqttAdapter({ createClient: () => client });
    const firstMessages: Array<{ topic: string; payload: Uint8Array }> = [];
    const secondMessages: Array<{ topic: string; payload: Uint8Array }> = [];

    const connectPromise = adapter.connect({ url: "mqtt://broker.example.com" });
    client.emitConnect();
    await connectPromise;

    const unsubscribeFirst = adapter.onMessage((message) => {
      firstMessages.push(message);
    });
    const unsubscribeSecond = adapter.onMessage((message) => {
      secondMessages.push(message);
    });

    client.emitMessage("amux/team-1/session/session-1/live", new Uint8Array([7, 8]));

    expect(firstMessages).toEqual([
      {
        topic: "amux/team-1/session/session-1/live",
        payload: new Uint8Array([7, 8]),
      },
    ]);
    expect(secondMessages).toEqual([
      {
        topic: "amux/team-1/session/session-1/live",
        payload: new Uint8Array([7, 8]),
      },
    ]);

    unsubscribeFirst();
    client.emitMessage("amux/team-1/session/session-1/live", new Uint8Array([9]));

    expect(firstMessages).toHaveLength(1);
    expect(secondMessages).toHaveLength(2);

    unsubscribeSecond();
    client.emitMessage("amux/team-1/session/session-1/live", new Uint8Array([10]));

    expect(firstMessages).toHaveLength(1);
    expect(secondMessages).toHaveLength(2);
  });
});
