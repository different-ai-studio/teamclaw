import mqttPkg from "mqtt";
import * as mqttNamespace from "mqtt";
import type { IClientOptions, MqttClient } from "mqtt";

// Metro's React-Native condition resolves the `mqtt` package to its prebuilt
// ESM bundle (`dist/mqtt.esm.js`), which only ships `export default`. Node
// resolution exposes a namespace with `connect` directly. Pick whichever
// shape actually has `connect` so vitest, Metro, and Node tests all work.
type MqttNamespace = {
  connect: (url: string, options?: IClientOptions) => unknown;
};
const mqtt: MqttNamespace = (mqttPkg && typeof (mqttPkg as MqttNamespace).connect === "function"
  ? (mqttPkg as MqttNamespace)
  : (mqttNamespace as unknown as MqttNamespace));

export type ExpoMqttMessage = {
  topic: string;
  payload: Uint8Array;
};

export type ExpoMqttConnectOptions = Pick<
  IClientOptions,
  | "clientId"
  | "username"
  | "password"
  | "clean"
  | "keepalive"
  | "reconnectPeriod"
  | "connectTimeout"
  | "protocol"
  | "hostname"
  | "port"
  | "path"
  | "rejectUnauthorized"
>;

export type ExpoMqttConnectArgs = {
  url: string;
  options?: ExpoMqttConnectOptions;
};

type ExpoMqttClientEventMap = {
  close: () => void;
  connect: () => void;
  error: (error: Error) => void;
  message: (topic: string, payload: Uint8Array) => void;
  offline: () => void;
};

type ExpoMqttClient = {
  on<E extends keyof ExpoMqttClientEventMap>(
    event: E,
    handler: ExpoMqttClientEventMap[E],
  ): ExpoMqttClient;
  once<E extends keyof ExpoMqttClientEventMap>(
    event: E,
    handler: ExpoMqttClientEventMap[E],
  ): ExpoMqttClient;
  removeListener<E extends keyof ExpoMqttClientEventMap>(
    event: E,
    handler: ExpoMqttClientEventMap[E],
  ): ExpoMqttClient;
  subscribe: (topic: string, callback: (error?: Error | null) => void) => void;
  publish: (
    topic: string,
    payload: Uint8Array | string,
    options: { retain?: boolean },
    callback: (error?: Error | null) => void,
  ) => void;
  end: (force: boolean, options: Record<string, never>, callback: () => void) => void;
};

export type ExpoMqttAdapter = {
  connect: (args: ExpoMqttConnectArgs) => Promise<void>;
  subscribe: (topic: string) => Promise<void>;
  publish: (topic: string, payload: Uint8Array, retain?: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
  onMessage: (handler: (message: ExpoMqttMessage) => void) => () => void;
  onConnectionState: (
    handler: (state: "connecting" | "connected" | "disconnected") => void,
  ) => () => void;
};

export type ExpoMqttAdapterDeps = {
  createClient?: (url: string, options?: ExpoMqttConnectOptions) => ExpoMqttClient;
  nativeModule?: NativeMqttModule | null;
  nativeEvents?: NativeEventSource | null;
};

function toMqttOptions(options?: ExpoMqttConnectOptions): ExpoMqttConnectOptions | undefined {
  return options;
}

function defaultCreateClient(url: string, options?: ExpoMqttConnectOptions): ExpoMqttClient {
  return mqtt.connect(url, toMqttOptions(options)) as unknown as ExpoMqttClient;
}

type NativeSubscription = {
  remove: () => void;
};

type NativeEventSource = {
  addListener: (event: string, handler: (payload: never) => void) => NativeSubscription;
};

type NativeMqttModule = {
  connect: (args: {
    host: string;
    port: number;
    useTls: boolean;
    username?: string;
    password?: string;
    clientId?: string;
    keepalive?: number;
    connectTimeout?: number;
  }) => Promise<void>;
  subscribe: (topic: string) => Promise<void>;
  publish: (topic: string, payload: number[], retain: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
};

type NativeModuleLookup = {
  NativeModules?: {
    TeamClawMqtt?: NativeMqttModule;
  };
  NativeEventEmitter?: new (module?: unknown) => NativeEventSource;
};

function getDefaultNativeAdapterDeps():
  | { nativeModule: NativeMqttModule; nativeEvents: NativeEventSource }
  | null {
  try {
    const reactNative = require("react-native") as NativeModuleLookup;
    const nativeModule = reactNative.NativeModules?.TeamClawMqtt;
    const NativeEventEmitter = reactNative.NativeEventEmitter;
    if (!nativeModule || !NativeEventEmitter) return null;
    return {
      nativeModule,
      nativeEvents: new NativeEventEmitter(nativeModule),
    };
  } catch {
    return null;
  }
}

function parseNativeUrl(url: string): { host: string; port: number; useTls: boolean } {
  const parsed = new URL(url);
  const protocol = parsed.protocol.replace(":", "");
  const useTls = protocol === "mqtts" || protocol === "ssl" || protocol === "tls" || protocol === "wss";
  const defaultPort = useTls ? 8883 : 1883;
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  if (!parsed.hostname || !Number.isFinite(port)) {
    throw new Error(`Invalid MQTT URL: ${url}`);
  }
  return {
    host: parsed.hostname,
    port,
    useTls,
  };
}

function toNativeString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  return undefined;
}

function createNativeMqttAdapter(
  nativeModule: NativeMqttModule,
  nativeEvents: NativeEventSource,
): ExpoMqttAdapter {
  const messageHandlers = new Set<(message: ExpoMqttMessage) => void>();
  const connectionStateHandlers = new Set<
    (state: "connecting" | "connected" | "disconnected") => void
  >();
  let subscriptions: NativeSubscription[] = [];
  let connected = false;

  function relayConnectionState(state: "connecting" | "connected" | "disconnected") {
    for (const handler of connectionStateHandlers) {
      handler(state);
    }
  }

  function ensureEventSubscriptions() {
    if (subscriptions.length > 0) return;
    subscriptions = [
      nativeEvents.addListener("TeamClawMqttMessage", (event) => {
        const payload = event as { topic?: string; payload?: number[] };
        if (!payload.topic || !Array.isArray(payload.payload)) return;
        const message = {
          topic: payload.topic,
          payload: new Uint8Array(payload.payload),
        };
        for (const handler of messageHandlers) {
          handler(message);
        }
      }),
      nativeEvents.addListener("TeamClawMqttConnectionState", (event) => {
        const payload = event as {
          state?: "connecting" | "connected" | "disconnected";
        };
        if (
          payload.state !== "connecting" &&
          payload.state !== "connected" &&
          payload.state !== "disconnected"
        ) {
          return;
        }
        connected = payload.state === "connected";
        relayConnectionState(payload.state);
      }),
    ];
  }

  function removeEventSubscriptions() {
    for (const subscription of subscriptions) {
      subscription.remove();
    }
    subscriptions = [];
  }

  return {
    async connect(args) {
      if (connected) {
        throw new Error("MQTT client is already connected");
      }
      ensureEventSubscriptions();
      relayConnectionState("connecting");
      const endpoint = parseNativeUrl(args.url);
      await nativeModule.connect({
        ...endpoint,
        username: toNativeString(args.options?.username),
        password: toNativeString(args.options?.password),
        clientId: args.options?.clientId,
        keepalive: args.options?.keepalive,
        connectTimeout: args.options?.connectTimeout,
      });
      connected = true;
    },
    async subscribe(topic) {
      if (!connected) {
        throw new Error("MQTT client is not connected");
      }
      await nativeModule.subscribe(topic);
    },
    async publish(topic, payload, retain = false) {
      if (!connected) {
        throw new Error("MQTT client is not connected");
      }
      await nativeModule.publish(topic, Array.from(payload), retain);
    },
    async disconnect() {
      if (!connected) {
        removeEventSubscriptions();
        relayConnectionState("disconnected");
        return;
      }
      connected = false;
      await nativeModule.disconnect();
      removeEventSubscriptions();
      relayConnectionState("disconnected");
    },
    onMessage(handler) {
      messageHandlers.add(handler);

      return () => {
        messageHandlers.delete(handler);
      };
    },
    onConnectionState(handler) {
      connectionStateHandlers.add(handler);

      return () => {
        connectionStateHandlers.delete(handler);
      };
    },
  };
}

export function createExpoMqttAdapter(deps: ExpoMqttAdapterDeps = {}): ExpoMqttAdapter {
  if (!deps.createClient) {
    const defaultNativeDeps = getDefaultNativeAdapterDeps();
    const nativeModule = deps.nativeModule ?? defaultNativeDeps?.nativeModule ?? null;
    const nativeEvents = deps.nativeEvents ?? defaultNativeDeps?.nativeEvents ?? null;
    if (nativeModule && nativeEvents) {
      return createNativeMqttAdapter(nativeModule, nativeEvents);
    }
  }

  const createClient = deps.createClient ?? defaultCreateClient;
  let client: ExpoMqttClient | null = null;
  const messageHandlers = new Set<(message: ExpoMqttMessage) => void>();
  const connectionStateHandlers = new Set<
    (state: "connecting" | "connected" | "disconnected") => void
  >();
  let pendingConnectCleanup: (() => void) | null = null;
  let pendingConnectReject: ((reason?: unknown) => void) | null = null;

  function relayMessage(topic: string, payload: Uint8Array) {
    const message = { topic, payload: new Uint8Array(payload) };
    for (const handler of messageHandlers) {
      handler(message);
    }
  }

  function relayConnectionState(state: "connecting" | "connected" | "disconnected") {
    for (const handler of connectionStateHandlers) {
      handler(state);
    }
  }

  return {
    async connect(args) {
      if (client) {
        throw new Error("MQTT client is already connected");
      }

      const nextClient = createClient(args.url, args.options);
      client = nextClient;
      relayConnectionState("connecting");

      return new Promise<void>((resolve, reject) => {
        pendingConnectReject = reject;

        const handleConnect = () => {
          nextClient.removeListener("connect", handleConnect);
          nextClient.removeListener("error", handleError);
          pendingConnectCleanup = null;
          nextClient.on("message", relayMessage);
          nextClient.on("close", handleDisconnected);
          nextClient.on("offline", handleDisconnected);
          nextClient.on("error", handleDisconnectedError);
          pendingConnectReject = null;
          relayConnectionState("connected");
          resolve();
        };

        const handleError = (error: Error) => {
          nextClient.removeListener("connect", handleConnect);
          nextClient.removeListener("error", handleError);
          pendingConnectCleanup = null;
          pendingConnectReject = null;
          if (client === nextClient) {
            client = null;
          }
          relayConnectionState("disconnected");
          reject(error);
        };

        const handleDisconnected = () => {
          if (client === nextClient) {
            client = null;
          }
          relayConnectionState("disconnected");
        };

        const handleDisconnectedError = (_error: Error) => {
          handleDisconnected();
        };

        pendingConnectCleanup = () => {
          nextClient.removeListener("connect", handleConnect);
          nextClient.removeListener("error", handleError);
        };

        nextClient.once("connect", handleConnect);
        nextClient.once("error", handleError);
      });
    },
    async subscribe(topic) {
      const currentClient = client;
      if (!currentClient) {
        throw new Error("MQTT client is not connected");
      }

      await new Promise<void>((resolve, reject) => {
        currentClient.subscribe(topic, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    async publish(topic, payload, retain = false) {
      const currentClient = client;
      if (!currentClient) {
        throw new Error("MQTT client is not connected");
      }

      await new Promise<void>((resolve, reject) => {
        currentClient.publish(topic, payload, { retain }, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    async disconnect() {
      if (!client) {
        pendingConnectCleanup?.();
        pendingConnectCleanup = null;
        if (pendingConnectReject) {
          pendingConnectReject(new Error("MQTT connection was closed before becoming ready"));
          pendingConnectReject = null;
        }
        relayConnectionState("disconnected");
        return;
      }

      const currentClient = client;
      client = null;
      pendingConnectCleanup?.();
      pendingConnectCleanup = null;
      if (pendingConnectReject) {
        pendingConnectReject(new Error("MQTT connection was closed before becoming ready"));
        pendingConnectReject = null;
      }
      relayConnectionState("disconnected");

      await new Promise<void>((resolve) => {
        currentClient.end(false, {}, resolve);
      });
    },
    onMessage(handler) {
      messageHandlers.add(handler);

      return () => {
        messageHandlers.delete(handler);
      };
    },
    onConnectionState(handler) {
      connectionStateHandlers.add(handler);

      return () => {
        connectionStateHandlers.delete(handler);
      };
    },
  };
}
