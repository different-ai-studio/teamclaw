import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { savedConfigRef, effectiveConfigRef, saveSpy, getSavedSpy, getEffectiveSpy } = vi.hoisted(() => {
  const savedConfigRef = { value: {} as Record<string, unknown> };
  const effectiveConfigRef = { value: {} as Record<string, unknown> };
  return {
    savedConfigRef,
    effectiveConfigRef,
    saveSpy: vi.fn(async (config: Record<string, unknown>) => {
      savedConfigRef.value = { ...config };
      return config;
    }),
    getSavedSpy: vi.fn(async () => savedConfigRef.value),
    getEffectiveSpy: vi.fn(async () => effectiveConfigRef.value),
  };
});

vi.mock("@/lib/server-config", () => ({
  getSavedServerConfig: getSavedSpy,
  getEffectiveServerConfig: getEffectiveSpy,
  saveServerConfig: saveSpy,
}));

import { clearBootstrapAppliedFields, fetchAndApplyBootstrap } from "../bootstrap";

beforeEach(() => {
  savedConfigRef.value = { cloudApiUrl: "https://cloud.example.com" };
  effectiveConfigRef.value = { cloudApiUrl: "https://cloud.example.com" };
  saveSpy.mockClear();
  getSavedSpy.mockClear();
  getEffectiveSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchAndApplyBootstrap", () => {
  it("is a no-op when access token is missing", async () => {
    const fetchImpl = vi.fn();
    await fetchAndApplyBootstrap({ accessToken: null, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when cloud API URL is not configured", async () => {
    effectiveConfigRef.value = {};
    const fetchImpl = vi.fn();
    await fetchAndApplyBootstrap({ accessToken: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("merges parsed MQTT broker URL into the saved config", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        mqtt: { url: "mqtts://mqtt.example.com:8883", username: "u", password: "p" },
      }),
    );
    await fetchAndApplyBootstrap({ accessToken: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cloud.example.com/v1/config/bootstrap",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) }),
    );
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toMatchObject({
      cloudApiUrl: "https://cloud.example.com",
      mqttHost: "mqtt.example.com",
      mqttPort: 8883,
      mqttUseTls: true,
      mqttUrl: "mqtts://mqtt.example.com:8883",
      mqttUsername: "u",
      mqttPassword: "p",
    });
  });

  it("prefers the canonical WebSocket URL when bootstrap also includes tcpUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        mqtt: {
          url: "ws://claw.example.com:8080/mqtt",
          tcpUrl: "mqtt://claw.example.com:8080",
          useTls: false,
        },
      }),
    );
    await fetchAndApplyBootstrap({ accessToken: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toMatchObject({
      mqttHost: "claw.example.com",
      mqttPort: 8080,
      mqttUseTls: false,
      mqttUrl: "ws://claw.example.com:8080/mqtt",
    });
  });

  it("does not touch saved config when payload lacks an mqtt url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    await fetchAndApplyBootstrap({ accessToken: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("clearBootstrapAppliedFields wipes mqtt fields but keeps cloudApiUrl", async () => {
    savedConfigRef.value = {
      cloudApiUrl: "https://cloud.example.com",
      mqttHost: "mqtt.old.example.com",
      mqttPort: 8883,
      mqttUseTls: true,
      mqttUsername: "u",
      mqttPassword: "p",
    };
    await clearBootstrapAppliedFields();
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toEqual({
      cloudApiUrl: "https://cloud.example.com",
      mqttHost: undefined,
      mqttPort: undefined,
      mqttUseTls: undefined,
      mqttUsername: undefined,
      mqttPassword: undefined,
    });
  });

  it("swallows network and HTTP errors", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      fetchAndApplyBootstrap({ accessToken: "tok", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
