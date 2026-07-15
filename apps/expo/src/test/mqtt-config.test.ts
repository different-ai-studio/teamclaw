import { describe, expect, it, vi } from "vitest";

describe("getOptionalMqttUrl", () => {
  it("defaults to the native TeamClaw broker when no env override exists", async () => {
    vi.stubEnv("EXPO_PUBLIC_MQTT_URL", "");
    const { getOptionalMqttUrl } = await import("../lib/mqtt/config");

    expect(getOptionalMqttUrl()).toBe("mqtts://ai.ucar.cc:8883");
  });

  it("uses the Expo MQTT env override when present", async () => {
    vi.stubEnv("EXPO_PUBLIC_MQTT_URL", " mqtts://broker.example.com:8883 ");
    const { getOptionalMqttUrl } = await import("../lib/mqtt/config");

    expect(getOptionalMqttUrl()).toBe("mqtts://broker.example.com:8883");
  });
});
