import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    items: store,
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  };
}

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

const auth = { getAccessToken: async () => "test-token" };

describe("resolveMqttUrl", () => {
  it("uses the Expo MQTT env override when present", async () => {
    vi.stubEnv("EXPO_PUBLIC_MQTT_URL", " mqtts://broker.example.com:8883 ");
    const { resolveMqttUrl } = await import("../lib/mqtt/config");

    const url = await resolveMqttUrl({ ...auth, baseUrl: "https://fc.example.com" });
    expect(url).toBe("mqtts://broker.example.com:8883");
  });

  it("prefers the Cloud API tcpUrl over the WebSocket url and caches it", async () => {
    vi.stubEnv("EXPO_PUBLIC_MQTT_URL", "");
    const { resolveMqttUrl } = await import("../lib/mqtt/config");
    const storage = memoryStorage();

    const url = await resolveMqttUrl({
      ...auth,
      baseUrl: "https://fc.example.com",
      fetchImpl: jsonFetch({
        mqtt: { url: "wss://mqtt.example.com/mqtt", tcpUrl: "mqtts://mqtt.example.com:8883" },
      }),
      storage,
    });

    expect(url).toBe("mqtts://mqtt.example.com:8883");
    expect(storage.items.get("teamclaw.mqtt.broker-url")).toBe("mqtts://mqtt.example.com:8883");
  });

  it("falls back to the cached address when the Cloud API is unreachable", async () => {
    vi.stubEnv("EXPO_PUBLIC_MQTT_URL", "");
    const { resolveMqttUrl } = await import("../lib/mqtt/config");
    const storage = memoryStorage({
      "teamclaw.mqtt.broker-url": "mqtts://cached.example.com:8883",
    });

    const url = await resolveMqttUrl({
      ...auth,
      baseUrl: "https://fc.example.com",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      storage,
    });

    expect(url).toBe("mqtts://cached.example.com:8883");
  });

  it("returns null when nothing has ever handed out an address", async () => {
    vi.stubEnv("EXPO_PUBLIC_MQTT_URL", "");
    const { resolveMqttUrl } = await import("../lib/mqtt/config");

    const url = await resolveMqttUrl({
      ...auth,
      baseUrl: "https://fc.example.com",
      fetchImpl: jsonFetch({ webSso: { loginUrl: "https://example.com" } }),
      storage: memoryStorage(),
    });

    expect(url).toBeNull();
  });
});
