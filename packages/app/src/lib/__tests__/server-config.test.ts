import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("server config", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves cloudApiUrl from the build config / env, never from a saved override", async () => {
    vi.stubEnv("VITE_CLOUD_API_URL", "https://build.example.com");

    const { getEffectiveServerConfig, getEffectiveServerConfigSync, saveServerConfig } = await import(
      "../server-config"
    );

    // A persisted cloudApiUrl must be ignored — the build config is the single
    // source of truth, so a stale value can never shadow it.
    await saveServerConfig({ cloudApiUrl: "https://stale.example.com" });

    expect(getEffectiveServerConfigSync().cloudApiUrl).toBe("https://build.example.com");
    expect((await getEffectiveServerConfig()).cloudApiUrl).toBe("https://build.example.com");
  });

  it("persists MQTT broker config delivered by bootstrap", async () => {
    const { getEffectiveServerConfigSync, saveServerConfig } = await import("../server-config");

    await saveServerConfig({
      mqttHost: " mqtt.example.com ",
      mqttPort: 1883,
      mqttUseTls: false,
    });

    const config = getEffectiveServerConfigSync();
    expect(config.mqttHost).toBe("mqtt.example.com");
    expect(config.mqttPort).toBe(1883);
    expect(config.mqttUseTls).toBe(false);
  });

  it("VITE_MQTT_WS_URL override wins over bootstrap-cached host/port/tls", async () => {
    vi.stubEnv("VITE_MQTT_WS_URL", "ws://ai.ucar.cc:8083/mqtt");

    localStorage.setItem(
      "teamclaw.serverConfig",
      JSON.stringify({
        mqttHost: "bootstrap.example.com",
        mqttPort: 1883,
        mqttUseTls: false,
        mqttUsername: "user1",
        mqttPassword: "pass1",
      }),
    );

    const { getEffectiveServerConfigSync } = await import("../server-config");
    const config = getEffectiveServerConfigSync();

    // Override wins for connection params
    expect(config.mqttHost).toBe("ai.ucar.cc");
    expect(config.mqttPort).toBe(8083);
    expect(config.mqttUseTls).toBe(false);
    // Credentials still come from bootstrap cache
    expect(config.mqttUsername).toBe("user1");
    expect(config.mqttPassword).toBe("pass1");
  });

  it("VITE_MQTT_WS_URL with wss:// sets mqttUseTls to true", async () => {
    vi.stubEnv("VITE_MQTT_WS_URL", "wss://ai.ucar.cc:8084/mqtt");

    const { getEffectiveServerConfigSync } = await import("../server-config");
    const config = getEffectiveServerConfigSync();

    expect(config.mqttHost).toBe("ai.ucar.cc");
    expect(config.mqttPort).toBe(8084);
    expect(config.mqttUseTls).toBe(true);
  });

  it("VITE_MQTT_WS_URL without a port defaults to 443 for wss (reverse proxy)", async () => {
    vi.stubEnv("VITE_MQTT_WS_URL", "wss://mqtt.teamclaw-dev.ucar.cc/mqtt");

    localStorage.setItem(
      "teamclaw.serverConfig",
      JSON.stringify({ mqttHost: "mqtt.teamclaw-dev.ucar.cc", mqttPort: 1883, mqttUseTls: false }),
    );

    const { getEffectiveServerConfigSync } = await import("../server-config");
    const config = getEffectiveServerConfigSync();

    // Must NOT inherit the bootstrap TCP port (1883); a portless wss URL means 443.
    expect(config.mqttHost).toBe("mqtt.teamclaw-dev.ucar.cc");
    expect(config.mqttPort).toBe(443);
    expect(config.mqttUseTls).toBe(true);
  });

  it("VITE_MQTT_WS_URL without a port defaults to 80 for ws", async () => {
    vi.stubEnv("VITE_MQTT_WS_URL", "ws://broker.local/mqtt");

    const { getEffectiveServerConfigSync } = await import("../server-config");
    const config = getEffectiveServerConfigSync();

    expect(config.mqttPort).toBe(80);
    expect(config.mqttUseTls).toBe(false);
  });


  it("without VITE_MQTT_WS_URL, bootstrap-cached values still win over env", async () => {
    vi.stubEnv("VITE_MQTT_HOST", "env.example.com");
    vi.stubEnv("VITE_MQTT_PORT", "9999");

    localStorage.setItem(
      "teamclaw.serverConfig",
      JSON.stringify({
        mqttHost: "bootstrap.example.com",
        mqttPort: 1883,
        mqttUseTls: false,
      }),
    );

    const { getEffectiveServerConfigSync } = await import("../server-config");
    const config = getEffectiveServerConfigSync();

    expect(config.mqttHost).toBe("bootstrap.example.com");
    expect(config.mqttPort).toBe(1883);
  });

  it("does not fall back to env MQTT credentials when saved config explicitly clears them", async () => {
    vi.stubEnv("VITE_MQTT_USERNAME", "teamclaw");
    vi.stubEnv("VITE_MQTT_PASSWORD", "teamclaw2026");

    localStorage.setItem(
      "teamclaw.serverConfig",
      JSON.stringify({
        mqttHost: "ai.ucar.cc",
        mqttPort: 1883,
        mqttUseTls: false,
        mqttUsername: null,
        mqttPassword: null,
      }),
    );

    const { getEffectiveServerConfigSync } = await import("../server-config");
    const config = getEffectiveServerConfigSync();

    expect(config.mqttUsername).toBeUndefined();
    expect(config.mqttPassword).toBeUndefined();
  });
});
