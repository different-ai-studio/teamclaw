import { describe, expect, it, vi } from "vitest";

import { createPushTokenApi } from "../features/notifications/push-token-api";

describe("createPushTokenApi", () => {
  it("POSTs the native push token to the Cloud API (user_id derived server-side)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const api = createPushTokenApi({
      baseUrl: "https://cloud.test",
      getAccessToken: async () => "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await api.upload({
      userId: "user-1",
      deviceId: "device-1",
      platform: "ios",
      provider: "apns",
      token: "abcdef",
      appVersion: "0.1.0",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.test/v1/devices/push-token");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({
      deviceId: "device-1",
      platform: "ios",
      provider: "apns",
      token: "abcdef",
      appVersion: "0.1.0",
    });
  });

  it("throws when the Cloud API rejects the upload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 400 }),
    );
    const api = createPushTokenApi({
      baseUrl: "https://cloud.test",
      getAccessToken: async () => "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      api.upload({
        userId: "user-1",
        deviceId: "device-1",
        platform: "ios",
        provider: "apns",
        token: "abcdef",
      }),
    ).rejects.toThrow("bad token");
  });
});
